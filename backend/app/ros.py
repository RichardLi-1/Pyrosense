"""Turn decoded ROS messages into plain backend types."""
from __future__ import annotations

import io
import math
from dataclasses import dataclass
from datetime import datetime, timezone

import numpy as np
from PIL import Image

PF_DTYPES = {1: "i1", 2: "u1", 3: "<i2", 4: "<u2", 5: "<i4", 6: "<u4", 7: "<f4", 8: "<f8"}


@dataclass(slots=True)
class Pose:
    ts: datetime
    x: float
    y: float
    heading: float  # radians, yaw in the map frame


@dataclass(slots=True)
class MapGrid:
    ts: datetime
    width: int
    height: int
    resolution: float
    origin_x: float
    origin_y: float
    data: np.ndarray  # int8, shape (height, width), row 0 at origin (ROS layout)

    @property
    def free_area_m2(self) -> float:
        return float(np.count_nonzero(self.data == 0)) * self.resolution ** 2


def stamp_to_datetime(stamp) -> datetime:
    return datetime.fromtimestamp(stamp.sec + stamp.nanosec * 1e-9, tz=timezone.utc)


def yaw_from_quaternion(qx: float, qy: float, qz: float, qw: float) -> float:
    return math.atan2(2.0 * (qw * qz + qx * qy), 1.0 - 2.0 * (qy * qy + qz * qz))


def pose_from_msg(msg) -> Pose:
    """geometry_msgs/PoseWithCovarianceStamped (slam_toolbox /pose) or PoseStamped."""
    p = msg.pose
    if hasattr(p, "pose"):  # PoseWithCovariance
        p = p.pose
    o = p.orientation
    return Pose(stamp_to_datetime(msg.header.stamp), float(p.position.x), float(p.position.y),
                yaw_from_quaternion(o.x, o.y, o.z, o.w))


def map_from_msg(msg) -> MapGrid:
    info = msg.info
    w, h = int(info.width), int(info.height)
    raw = msg.data
    data = np.frombuffer(bytes(raw), dtype=np.int8) if isinstance(raw, (bytes, bytearray)) \
        else np.asarray(raw, dtype=np.int8)
    return MapGrid(stamp_to_datetime(msg.header.stamp), w, h, float(info.resolution),
                   float(info.origin.position.x), float(info.origin.position.y),
                   data.reshape(h, w))


def _cloud_reader(msg):
    """(n, fields, col) for a PointCloud2; col(name, out_dtype) reads one field or returns None."""
    n = int(msg.width) * int(msg.height)
    fields = {f.name: f for f in msg.fields}
    buf = bytes(msg.data) if not isinstance(msg.data, (bytes, bytearray)) else msg.data
    step = int(msg.point_step)
    endian = ">" if msg.is_bigendian else "<"

    def col(name: str, out=np.float32) -> np.ndarray | None:
        f = fields.get(name)
        if f is None:
            return None
        dt = np.dtype(PF_DTYPES[int(f.datatype)]).newbyteorder(endian)
        view = np.ndarray(shape=(n,), dtype=dt, buffer=buf, offset=int(f.offset), strides=(step,))
        return view.astype(out)

    return n, fields, col


def points_from_pointcloud(msg) -> np.ndarray:
    """sensor_msgs/PointCloud2 -> float32 array of shape (N, 4): x, y, z, voc.

    Field offsets are read from the message, so any layout that carries x, y and
    voc works; z is optional.
    """
    n, fields, col = _cloud_reader(msg)
    if n == 0:
        return np.zeros((0, 4), dtype=np.float32)
    missing = [k for k in ("x", "y", "voc") if k not in fields]
    if missing:
        raise ValueError(f"PointCloud2 lacks fields {missing}; have {sorted(fields)}")
    z = col("z")
    return np.stack([col("x"), col("y"), z if z is not None else np.zeros(n, np.float32), col("voc")], axis=1)


def point_times(msg) -> np.ndarray | None:
    """Optional per-point `t` field (unix seconds, FLOAT64) -> float64 array, else None."""
    n, fields, col = _cloud_reader(msg)
    if "t" not in fields:
        return None
    return np.zeros(0) if n == 0 else col("t", np.float64)


def map_to_png(grid: MapGrid) -> bytes:
    """Occupancy grid -> RGBA PNG, north-up (image row 0 = max y).

    occupied (>=65) -> #e6e8ec @ 85 %; free (0..64) -> #151a24 opaque; unknown (-1) -> transparent.
    """
    d = grid.data
    rgba = np.zeros((grid.height, grid.width, 4), dtype=np.uint8)
    free = (d >= 0) & (d < 65)
    occ = d >= 65
    rgba[free] = (0x15, 0x1A, 0x24, 255)
    rgba[occ] = (0xE6, 0xE8, 0xEC, 217)
    img = Image.fromarray(rgba[::-1], mode="RGBA")  # flip so +y is up
    out = io.BytesIO()
    img.save(out, format="PNG", optimize=False, compress_level=3)
    return out.getvalue()
