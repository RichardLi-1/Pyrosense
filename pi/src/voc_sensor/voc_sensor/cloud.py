"""Pack (x, y, z, voc) points into the PointCloud2 byte layout the backend expects:
four little-endian float32 fields, point_step 16. Pure Python/numpy, testable off the Pi."""
from __future__ import annotations

from typing import Iterable, Sequence

import numpy as np

FIELDS: Sequence[tuple[str, int]] = (("x", 0), ("y", 4), ("z", 8), ("voc", 12))
POINT_STEP = 16
FLOAT32 = 7  # sensor_msgs/PointField.FLOAT32


def pack_points(points: Iterable[Sequence[float]]) -> tuple[bytes, int]:
    arr = np.asarray(list(points), dtype="<f4").reshape(-1, 4)
    return arr.tobytes(), int(arr.shape[0])


def make_cloud_msg(points, stamp, frame_id: str):
    """Build a sensor_msgs/PointCloud2 (imports ROS types lazily)."""
    from sensor_msgs.msg import PointCloud2, PointField
    data, n = pack_points(points)
    msg = PointCloud2()
    msg.header.stamp = stamp
    msg.header.frame_id = frame_id
    msg.height = 1
    msg.width = n
    msg.fields = [PointField(name=name, offset=off, datatype=FLOAT32, count=1) for name, off in FIELDS]
    msg.is_bigendian = False
    msg.point_step = POINT_STEP
    msg.row_step = POINT_STEP * n
    msg.data = data
    msg.is_dense = True
    return msg
