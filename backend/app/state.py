"""In-memory live state + fan-out to /ws/live clients. No DB on this path."""
from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import numpy as np

from .ros import MapGrid, Pose

log = logging.getLogger("state")


@dataclass
class MapState:
    grid: MapGrid
    png: bytes
    version: int

    def event(self) -> dict[str, Any]:
        g = self.grid
        return {
            "t": "map", "url": f"/map?v={self.version}", "version": self.version,
            "origin": [g.origin_x, g.origin_y], "res": g.resolution, "w": g.width, "h": g.height,
            "y_up": True, "free_area_m2": round(g.free_area_m2, 2),
            "ts": g.ts.isoformat(),
        }


def _key(row: np.ndarray) -> tuple:
    return tuple(np.round(row, 4).tolist())


def _keys(rows: np.ndarray) -> list[tuple]:
    return [tuple(r) for r in np.round(rows, 4).tolist()]


class PointTracker:
    """Picks the not-yet-seen points out of each /voc_points message.

    With a per-point `t` field a point is new iff its t is later than any seen so far,
    whatever the publisher sends (full list, ring buffer or one point at a time).
    Without `t` we guess from length and content, which cannot tell a re-publish from
    a new identical reading (standing still, same integer VOC index): those are dropped.
    """

    SEEN_MAX = 120_000

    def __init__(self) -> None:
        self.processed = 0
        self.last_t: float | None = None
        self._last: tuple | None = None
        self._seen: dict[tuple, None] = {}  # insertion-ordered, so trimming keeps the newest

    def reset(self) -> None:
        self.processed = 0
        self.last_t = None
        self._last = None
        self._seen.clear()

    def new_index(self, pts: np.ndarray, t: np.ndarray | None = None) -> np.ndarray:
        """Indices into pts of the points not seen before."""
        n = len(pts)
        if n == 0:
            return np.zeros(0, dtype=np.intp)
        if t is not None:
            idx = np.arange(n) if self.last_t is None else np.flatnonzero(t > self.last_t)
            if len(idx):
                self.last_t = float(t[idx].max())
            return idx
        if n < self.processed:  # mapper restarted / reset
            self.reset()
        if n > self.processed:
            idx = np.arange(self.processed, n)
        else:
            if _key(pts[-1]) == self._last:
                return np.zeros(0, dtype=np.intp)
            # same length, new content: ring buffer at capacity -> set difference
            keys = _keys(pts)
            idx = np.flatnonzero([k not in self._seen for k in keys])
        self.processed = n
        self._last = _key(pts[-1])
        self._seen.update(dict.fromkeys(_keys(pts[idx])))
        if len(self._seen) > self.SEEN_MAX:
            self._seen = dict.fromkeys(list(self._seen)[-self.SEEN_MAX // 2:])
        return idx

    def new_points(self, pts: np.ndarray, t: np.ndarray | None = None) -> np.ndarray:
        return pts[self.new_index(pts, t)]


@dataclass
class LiveState:
    session: str
    voc_window_seconds: float = 60.0
    started_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    pose: Pose | None = None
    voc: float | None = None
    voc_ts: datetime | None = None
    voc_window: deque = field(default_factory=deque)  # (unix seconds, voc)
    map: MapState | None = None
    n_samples: int = 0
    bridge_connected: bool = False
    sensor: dict[str, Any] | None = None  # latest raw /voc frame (eCO2, raw signals, warm-up)
    tracker: PointTracker = field(default_factory=PointTracker)
    _map_version: int = 0

    def new_session(self, session: str) -> None:
        self.session = session
        self.started_at = datetime.now(timezone.utc)
        self.pose = None
        self.voc = None
        self.voc_ts = None
        self.voc_window.clear()
        self.n_samples = 0
        self.sensor = None
        # Keep the tracker: the Pi's list still holds the old session's points, and
        # only readings published after the switch belong to the new session.

    def set_map(self, grid: MapGrid, png: bytes) -> MapState:
        self._map_version += 1
        self.map = MapState(grid, png, self._map_version)
        return self.map

    def push_voc(self, voc: float, ts: datetime) -> None:
        self.voc = voc
        self.voc_ts = ts
        now = time.time()
        self.voc_window.append((now, voc))
        cutoff = now - self.voc_window_seconds
        while self.voc_window and self.voc_window[0][0] < cutoff:
            self.voc_window.popleft()

    def pose_event(self) -> dict[str, Any] | None:
        if self.pose is None:
            return None
        return {"t": "pose", "ts": self.pose.ts.isoformat(), "x": self.pose.x, "y": self.pose.y,
                "heading": self.pose.heading, "voc": self.voc}

    def hello_event(self, threshold: float, unit: str = "ppb") -> dict[str, Any]:
        return {"t": "hello", "session": self.session, "started": self.started_at.isoformat(),
                "threshold": threshold, "unit": unit, "sensor": self.sensor, "bridge_connected": self.bridge_connected,
                "n_samples": self.n_samples,
                "voc_window": [[round(t, 3), v] for t, v in self.voc_window]}


class Broadcaster:
    """Per-client bounded queues; slow clients drop oldest events instead of blocking ingest."""

    def __init__(self, maxsize: int = 256) -> None:
        self._queues: set[asyncio.Queue] = set()
        self.maxsize = maxsize

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=self.maxsize)
        self._queues.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._queues.discard(q)

    @property
    def n_clients(self) -> int:
        return len(self._queues)

    def publish(self, event: dict[str, Any]) -> None:
        for q in list(self._queues):
            if q.full():
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            q.put_nowait(event)
