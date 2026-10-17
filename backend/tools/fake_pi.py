"""Fake Pi: a Foxglove WebSocket server that publishes /pose, /map and /voc_points
exactly as foxglove_bridge would (CDR, ros2msg schemas), so the backend and
dashboard can be developed and demoed without hardware.

    python -m tools.fake_pi --port 8765 --spike-at 20

The walker loops around a 10 x 7 m room. A persistent VOC source sits in one
corner; `--spike-at N` adds a sharp spike N seconds in (the marker test).
"""
from __future__ import annotations

import argparse
import asyncio
import math
import random
import time

import numpy as np
from foxglove_websocket.server import FoxgloveServer

from app.cdr import CdrWriter
from app.ros_schemas import SCHEMAS

ROOM_W, ROOM_H, RES = 10.0, 7.0, 0.05
ORIGIN = (-1.0, -1.0)


def now_stamp() -> tuple[int, int]:
    t = time.time()
    return int(t), int((t % 1) * 1e9)


def encode_pose(x: float, y: float, yaw: float) -> bytes:
    sec, nsec = now_stamp()
    w = CdrWriter().header(sec, nsec, "map")
    w.pose(x, y, 0.0, 0.0, 0.0, math.sin(yaw / 2), math.cos(yaw / 2))
    w.float64_array([0.0] * 36)
    return w.finish()


def encode_map(grid: np.ndarray) -> bytes:
    sec, nsec = now_stamp()
    h, w_ = grid.shape
    w = CdrWriter().header(sec, nsec, "map")
    w.time(sec, nsec).float32(RES).uint32(w_).uint32(h)
    w.pose(ORIGIN[0], ORIGIN[1], 0.0, 0.0, 0.0, 0.0, 1.0)
    w.bytes_seq(grid.astype(np.int8).tobytes())
    return w.finish()


POINT_DTYPE = np.dtype([("x", "<f4"), ("y", "<f4"), ("z", "<f4"), ("voc", "<f4")])
POINT_DTYPE_T = np.dtype([("x", "<f4"), ("y", "<f4"), ("z", "<f4"), ("voc", "<f4"), ("t", "<f8")])


def encode_points(pts: np.ndarray, times: np.ndarray | None = None) -> bytes:
    """pts (N, 4) x, y, z, voc; times (N,) unix seconds adds a FLOAT64 `t` field (point_step 24)."""
    sec, nsec = now_stamp()
    n = len(pts)
    dtype = POINT_DTYPE if times is None else POINT_DTYPE_T
    rec = np.zeros(n, dtype=dtype)
    for i, name in enumerate(("x", "y", "z", "voc")):
        rec[name] = pts[:, i]
    if times is not None:
        rec["t"] = times
    w = CdrWriter().header(sec, nsec, "map")
    w.uint32(1).uint32(n)
    w.uint32(len(dtype.names))
    for name in dtype.names:
        w.string(name).uint32(dtype.fields[name][1]).uint8(8 if name == "t" else 7).uint32(1)
    w.bool(False).uint32(dtype.itemsize).uint32(dtype.itemsize * n)
    w.bytes_seq(rec.tobytes())
    w.bool(True)
    return w.finish()


class Walker:
    """Rectangle loop, revealing the occupancy grid within LiDAR range as it goes."""

    def __init__(self, speed: float = 0.7) -> None:
        self.speed = speed
        self.path = [(1.0, 1.0), (ROOM_W - 1.0, 1.0), (ROOM_W - 1.0, ROOM_H - 1.0), (1.0, ROOM_H - 1.0)]
        self.seg, self.s = 0, 0.0
        self.x, self.y, self.yaw = self.path[0][0], self.path[0][1], 0.0
        gw, gh = int((ROOM_W + 2) / RES), int((ROOM_H + 2) / RES)
        self.grid = np.full((gh, gw), -1, dtype=np.int8)

    def step(self, dt: float) -> None:
        a = self.path[self.seg]; b = self.path[(self.seg + 1) % 4]
        L = math.hypot(b[0] - a[0], b[1] - a[1])
        self.s += self.speed * dt
        if self.s >= L:
            self.s -= L; self.seg = (self.seg + 1) % 4
            a = self.path[self.seg]; b = self.path[(self.seg + 1) % 4]; L = math.hypot(b[0] - a[0], b[1] - a[1])
        f = self.s / L
        self.x = a[0] + (b[0] - a[0]) * f + random.gauss(0, 0.01)
        self.y = a[1] + (b[1] - a[1]) * f + random.gauss(0, 0.01)
        self.yaw = math.atan2(b[1] - a[1], b[0] - a[0])
        self._reveal()

    def _reveal(self, r: float = 4.0) -> None:
        gh, gw = self.grid.shape
        cx, cy = int((self.x - ORIGIN[0]) / RES), int((self.y - ORIGIN[1]) / RES)
        rr = int(r / RES)
        y0, y1 = max(0, cy - rr), min(gh, cy + rr); x0, x1 = max(0, cx - rr), min(gw, cx + rr)
        ys, xs = np.mgrid[y0:y1, x0:x1]
        inside = (xs - cx) ** 2 + (ys - cy) ** 2 <= rr * rr
        wx = ORIGIN[0] + (xs + 0.5) * RES; wy = ORIGIN[1] + (ys + 0.5) * RES
        wall = (np.abs(wx) < RES) | (np.abs(wx - ROOM_W) < RES) | (np.abs(wy) < RES) | (np.abs(wy - ROOM_H) < RES)
        room = (wx > 0) & (wx < ROOM_W) & (wy > 0) & (wy < ROOM_H)
        sub = self.grid[y0:y1, x0:x1]
        sub[inside & room] = 0
        sub[inside & wall] = 100


def voc_at(x: float, y: float, t: float, spike_at: float | None) -> float:
    base = 60 + 25 * math.sin(t / 30)
    source = 300 * math.exp(-(((x - (ROOM_W - 1.5)) ** 2 + (y - 1.5) ** 2) / (2 * 1.2 ** 2)))
    spike = 0.0
    if spike_at is not None and t >= spike_at:
        spike = 380 * math.exp(-(t - spike_at) / 25)
    return max(5.0, base + source + spike + random.gauss(0, 6))


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="0.0.0.0"); ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--spike-at", type=float, default=None, help="seconds until a VOC spike")
    ap.add_argument("--pose-hz", type=float, default=10.0); ap.add_argument("--voc-hz", type=float, default=2.0)
    ap.add_argument("--map-period", type=float, default=1.0); ap.add_argument("--max-points", type=int, default=50000)
    args = ap.parse_args()

    async with FoxgloveServer(args.host, args.port, "fake_pi") as server:
        ch = {}
        for topic, schema in (("/pose", "geometry_msgs/msg/PoseWithCovarianceStamped"),
                              ("/map", "nav_msgs/msg/OccupancyGrid"),
                              ("/voc_points", "sensor_msgs/msg/PointCloud2")):
            ch[topic] = await server.add_channel({"topic": topic, "encoding": "cdr", "schemaName": schema,
                                                  "schema": SCHEMAS[schema], "schemaEncoding": "ros2msg"})
        print(f"fake_pi: ws://{args.host}:{args.port}  topics={list(ch)}  spike_at={args.spike_at}")
        walker = Walker()
        pts: list[tuple[float, float, float, float]] = []
        times: list[float] = []
        t0 = time.time(); last_voc = last_map = t0
        dt = 1.0 / args.pose_hz
        while True:
            now = time.time(); t = now - t0
            walker.step(dt)
            await server.send_message(ch["/pose"], time.time_ns(), encode_pose(walker.x, walker.y, walker.yaw))
            if now - last_voc >= 1.0 / args.voc_hz:
                last_voc = now
                pts.append((walker.x, walker.y, 0.0, voc_at(walker.x, walker.y, t, args.spike_at)))
                times.append(now)
                if len(pts) > args.max_points:
                    pts, times = pts[-args.max_points:], times[-args.max_points:]
                await server.send_message(ch["/voc_points"], time.time_ns(),
                                          encode_points(np.array(pts, dtype="<f4"), np.array(times)))
            if now - last_map >= args.map_period:
                last_map = now
                await server.send_message(ch["/map"], time.time_ns(), encode_map(walker.grid))
            await asyncio.sleep(dt)


if __name__ == "__main__":
    asyncio.run(main())
