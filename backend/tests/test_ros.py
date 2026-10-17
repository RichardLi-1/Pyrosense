"""ROS message -> backend type adapters, on hand-built messages (no CDR involved)."""
import io
import math
from datetime import datetime, timezone
from types import SimpleNamespace as NS

import numpy as np
import pytest
from PIL import Image

from app.ros import (MapGrid, map_from_msg, map_to_png, point_times, points_from_pointcloud,
                     pose_from_msg, stamp_to_datetime, yaw_from_quaternion)

STAMP = NS(sec=1760670000, nanosec=500_000_000)


def cloud(fields, step, data, n, *, height=1, big=False):
    return NS(header=NS(stamp=STAMP), width=n, height=height, point_step=step, is_bigendian=big,
              fields=[NS(name=a, offset=o, datatype=d, count=1) for a, o, d in fields], data=data)


XYZV = [("x", 0, 7), ("y", 4, 7), ("z", 8, 7), ("voc", 12, 7)]


def test_stamp_to_datetime():
    assert stamp_to_datetime(STAMP) == datetime(2025, 10, 17, 3, 0, 0, 500000, tzinfo=timezone.utc)


@pytest.mark.parametrize("deg", [0, 31, 90, 179, -90, -179])
def test_yaw_matches_angle(deg):
    a = math.radians(deg)
    assert math.isclose(yaw_from_quaternion(0, 0, math.sin(a / 2), math.cos(a / 2)), a, abs_tol=1e-9)


def test_pose_from_posestamped_and_with_covariance():
    q = NS(x=0, y=0, z=math.sin(0.25), w=math.cos(0.25))
    inner = NS(position=NS(x=4.35, y=-1.04, z=0), orientation=q)
    for msg in (NS(header=NS(stamp=STAMP), pose=inner),                       # PoseStamped
                NS(header=NS(stamp=STAMP), pose=NS(pose=inner, covariance=[0] * 36))):  # WithCovariance
        p = pose_from_msg(msg)
        assert (p.x, p.y) == (4.35, -1.04) and math.isclose(p.heading, 0.5)


def test_pointcloud_reads_offsets_padding_and_height():
    # 20-byte points with voc before x and 4 bytes of padding; 2 x 2 cloud.
    dt = np.dtype({"names": ["voc", "x", "y"], "formats": ["<f4"] * 3, "offsets": [0, 4, 8], "itemsize": 20})
    rec = np.zeros(4, dt); rec["x"] = [1, 2, 3, 4]; rec["y"] = [5, 6, 7, 8]; rec["voc"] = [9, 10, 11, 12]
    msg = cloud([("voc", 0, 7), ("x", 4, 7), ("y", 8, 7)], 20, rec.tobytes(), 2, height=2)
    pts = points_from_pointcloud(msg)
    assert pts.dtype == np.float32 and pts.tolist() == [[1, 5, 0, 9], [2, 6, 0, 10], [3, 7, 0, 11], [4, 8, 0, 12]]


def test_pointcloud_big_endian_and_non_float_voc():
    dt = np.dtype([("x", ">f4"), ("y", ">f4"), ("voc", ">u2")])
    rec = np.array([(1.5, -2.0, 183)], dt)
    msg = cloud([("x", 0, 7), ("y", 4, 7), ("voc", 8, 4)], dt.itemsize, list(rec.tobytes()), 1, big=True)
    assert points_from_pointcloud(msg).tolist() == [[1.5, -2.0, 0.0, 183.0]]


def test_pointcloud_missing_field_errors():
    with pytest.raises(ValueError, match="voc"):
        points_from_pointcloud(cloud([("x", 0, 7), ("y", 4, 7)], 8, bytes(8), 1))


def test_point_times():
    dt = np.dtype([("x", "<f4"), ("y", "<f4"), ("z", "<f4"), ("voc", "<f4"), ("t", "<f8")])
    rec = np.array([(1, 2, 0, 3, 1760670000.25), (4, 5, 0, 6, 1760670001.75)], dt)
    msg = cloud(XYZV + [("t", 16, 8)], 24, rec.tobytes(), 2)
    t = point_times(msg)
    assert t.dtype == np.float64 and t.tolist() == [1760670000.25, 1760670001.75]  # µs-exact, unlike float32
    assert points_from_pointcloud(msg).tolist() == [[1, 2, 0, 3], [4, 5, 0, 6]]
    assert point_times(cloud(XYZV, 16, bytes(16), 1)) is None
    assert point_times(cloud(XYZV + [("t", 16, 8)], 24, b"", 0)).shape == (0,)


def test_map_from_msg_bytes_and_list():
    for data in (bytes([255, 0, 100, 0, 255, 50]), [-1, 0, 100, 0, -1, 50]):
        msg = NS(header=NS(stamp=STAMP), data=data,
                 info=NS(width=3, height=2, resolution=0.5, origin=NS(position=NS(x=-1.0, y=2.0))))
        g = map_from_msg(msg)
        assert g.data.tolist() == [[-1, 0, 100], [0, -1, 50]]
        assert (g.origin_x, g.origin_y) == (-1.0, 2.0) and g.free_area_m2 == 0.5


def test_map_png_is_north_up_with_palette():
    data = np.array([[0, 100, -1],     # row 0 = lowest y (ROS)
                     [-1, -1, 64]], np.int8)
    g = MapGrid(datetime.now(timezone.utc), 3, 2, 0.05, 0, 0, data)
    img = np.array(Image.open(io.BytesIO(map_to_png(g))))
    assert img.shape == (2, 3, 4)
    assert img[1].tolist() == [[0x15, 0x1A, 0x24, 255], [0xE6, 0xE8, 0xEC, 217], [0, 0, 0, 0]]  # ROS row 0 at bottom
    assert img[0].tolist() == [[0, 0, 0, 0], [0, 0, 0, 0], [0x15, 0x1A, 0x24, 255]]           # 64 counts as free
