"""Pack gas points into the PointCloud2 byte layout the backend expects.

Fields: x, y, z, voc (float32) and t (float64, unix seconds of the reading), point_step 24.
`t` lets the backend de-duplicate exactly, so the mapper can publish only new points.
Pure Python/numpy, testable off the Pi.
"""
from __future__ import annotations

from typing import Iterable, Sequence

import numpy as np

FIELDS: Sequence[tuple[str, int, int]] = (("x", 0, 7), ("y", 4, 7), ("z", 8, 7), ("voc", 12, 7), ("t", 16, 8))
POINT_STEP = 24
DTYPE = np.dtype({"names": ["x", "y", "z", "voc", "t"], "formats": ["<f4", "<f4", "<f4", "<f4", "<f8"],
                  "offsets": [0, 4, 8, 12, 16], "itemsize": POINT_STEP})


def pack_points(points: Iterable[Sequence[float]]) -> tuple[bytes, int]:
    """points: iterable of (x, y, z, voc, t). Returns (bytes, n)."""
    rows = list(points)
    arr = np.zeros(len(rows), dtype=DTYPE)
    if rows:
        a = np.asarray(rows, dtype=np.float64).reshape(-1, 5)
        arr["x"], arr["y"], arr["z"], arr["voc"], arr["t"] = a[:, 0], a[:, 1], a[:, 2], a[:, 3], a[:, 4]
    return arr.tobytes(), len(rows)


def make_cloud_msg(points, stamp, frame_id: str):
    """Build a sensor_msgs/PointCloud2 (imports ROS types lazily)."""
    from sensor_msgs.msg import PointCloud2, PointField
    data, n = pack_points(points)
    msg = PointCloud2()
    msg.header.stamp = stamp
    msg.header.frame_id = frame_id
    msg.height = 1
    msg.width = n
    msg.fields = [PointField(name=name, offset=off, datatype=dt, count=1) for name, off, dt in FIELDS]
    msg.is_bigendian = False
    msg.point_step = POINT_STEP
    msg.row_step = POINT_STEP * n
    msg.data = data
    msg.is_dense = True
    return msg
