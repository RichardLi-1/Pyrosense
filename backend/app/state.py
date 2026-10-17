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


class PointTracker:
    """De-duplicates /voc_points, which voc_mapper publishes as the full list each time."""

    def __init__(self) -> None:
        self.processed = 0
        self._last: tuple | None = None
        self._seen: set[tuple] = set()

    def reset(self) -> None:
        self.processed = 0
        self._last = None
        self._seen.clear()

    def new_points(self, pts: np.ndarray) -> np.ndarray:
        n = len(pts)
        if n == 0:
            return pts
        if n < self.processed:  # mapper restarted / reset
            self.reset()
        if n > self.processed:
            new = pts[self.processed:]
        else:
            last = tuple(np.round(pts[-1], 4).tolist())
            if last == self._last:
                return pts[:0]
            # same length, new content: ring buffer at capacity -> set difference
            keys = [tuple(k) for k in np.round(pts, 4).tolist()]
            mask = np.fromiter((k not in self._seen for k in keys), dtype=bool, count=n)
            new = pts[mask]
        self.processed = n
        self._last = tuple(np.round(pts[-1], 4).tolist())
        for k in np.round(new, 4).tolist():
            self._seen.add(tuple(k))
        if len(self._seen) > 120_000:
            self._seen = set(list(self._seen)[-60_000:])
        return new


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
        self.tracker.reset()

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

    def hello_event(self, threshold: float) -> dict[str, Any]:
        return {"t": "hello", "session": self.session, "started": self.started_at.isoformat(),
                "threshold": threshold, "bridge_connected": self.bridge_connected,
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
