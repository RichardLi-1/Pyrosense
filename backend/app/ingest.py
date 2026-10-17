"""Glue between the Foxglove stream and everything else: cache, DB buffer, alerts, fan-out."""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone

from .alerts import AlertEngine
from .config import TOPIC_MAP, TOPIC_POSE, TOPIC_VOC_POINTS, Settings
from .db import Database
from .ros import map_from_msg, map_to_png, point_times, points_from_pointcloud, pose_from_msg, stamp_to_datetime
from .state import Broadcaster, LiveState

log = logging.getLogger("ingest")


class Ingest:
    def __init__(self, settings: Settings, state: LiveState, db: Database, bus: Broadcaster,
                 alerts: AlertEngine) -> None:
        self.s = settings
        self.state = state
        self.db = db
        self.bus = bus
        self.alerts = alerts
        self._pose_interval = 1.0 / max(settings.live_pose_hz, 0.1)
        self._last_pose_sent = 0.0
        self._clock_warned = 0.0

    async def on_message(self, topic: str, msg, recv_ns: int) -> None:
        if topic == TOPIC_POSE:
            self._on_pose(msg)
        elif topic == TOPIC_VOC_POINTS:
            await self._on_points(msg)
        elif topic == TOPIC_MAP:
            self._on_map(msg)

    def _on_pose(self, msg) -> None:
        pose = pose_from_msg(msg)
        self.state.pose = pose
        self._check_clock(pose.ts)
        now = time.monotonic()
        if now - self._last_pose_sent >= self._pose_interval:
            self._last_pose_sent = now
            ev = self.state.pose_event()
            if ev:
                self.bus.publish(ev)

    def _on_map(self, msg) -> None:
        grid = map_from_msg(msg)
        png = map_to_png(grid)
        ms = self.state.set_map(grid, png)
        self.bus.publish(ms.event())

    async def _on_points(self, msg) -> None:
        pts = points_from_pointcloud(msg)
        t = point_times(msg)
        idx = self.state.tracker.new_index(pts, t)
        if len(idx) == 0:
            return
        new = pts[idx]
        if t is not None:
            stamps = [datetime.fromtimestamp(s, tz=timezone.utc) for s in t[idx].tolist()]
        else:
            stamps = [stamp_to_datetime(msg.header.stamp)] * len(new)
        ts = stamps[-1]
        heading = self.state.pose.heading if self.state.pose else None
        session = self.state.session
        rows = [(st, session, float(x), float(y), heading, float(v))
                for st, (x, y, _z, v) in zip(stamps, new.tolist())]
        self.db.add_readings(rows)
        self.state.n_samples += len(rows)
        latest = float(new[-1, 3])
        self.state.push_voc(latest, ts)
        self.bus.publish({"t": "voc", "ts": ts.isoformat(), "voc": latest, "n_new": len(rows),
                          "x": float(new[-1, 0]), "y": float(new[-1, 1])})
        if self.alerts.update(latest, time.time()):
            await self._fire_alert(latest, float(new[-1, 0]), float(new[-1, 1]), ts)

    async def _fire_alert(self, voc: float, x: float, y: float, ts: datetime) -> None:
        m = self.state.map
        alert_id = None
        try:
            alert_id = await self.db.insert_alert(
                ts, self.state.session, x, y, voc,
                m.png if m else None, (m.grid.origin_x, m.grid.origin_y) if m else None,
                m.grid.resolution if m else None)
        except Exception as e:  # noqa: BLE001
            log.warning("alert not persisted: %s", e)
        ev = {"t": "alert", "id": alert_id, "ts": ts.isoformat(), "x": x, "y": y, "voc": voc,
              "threshold": self.alerts.threshold,
              "map_png_url": f"/alerts/{alert_id}/map.png" if alert_id is not None else None}
        log.warning("ALERT voc=%.0f at (%.2f, %.2f)", voc, x, y)
        self.bus.publish(ev)

    def _check_clock(self, ts: datetime) -> None:
        skew = abs((datetime.now(timezone.utc) - ts).total_seconds())
        if skew > 2.0 and time.monotonic() - self._clock_warned > 30:
            self._clock_warned = time.monotonic()
            log.warning("Pi clock skew %.1fs (check chrony on the Pi)", skew)
