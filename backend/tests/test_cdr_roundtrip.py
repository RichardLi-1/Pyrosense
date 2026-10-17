"""Our CDR encoder must produce payloads the mcap_ros2 dynamic decoder (and therefore
real foxglove_bridge output) decodes, and our ROS adapters must read them back."""
import math

import numpy as np

from app.foxglove import build_decoder
from app.ros import map_from_msg, points_from_pointcloud, pose_from_msg, yaw_from_quaternion
from app.ros_schemas import SCHEMAS
from tools.fake_pi import encode_map, encode_points, encode_pose


def test_pose_roundtrip():
    dec = build_decoder("geometry_msgs/msg/PoseWithCovarianceStamped",
                        SCHEMAS["geometry_msgs/msg/PoseWithCovarianceStamped"])
    msg = dec(encode_pose(4.35, -1.04, 0.54))
    assert msg.header.frame_id == "map"
    p = pose_from_msg(msg)
    assert math.isclose(p.x, 4.35) and math.isclose(p.y, -1.04)
    assert math.isclose(p.heading, 0.54, abs_tol=1e-9)


def test_yaw():
    assert math.isclose(yaw_from_quaternion(0, 0, 0.267, 0.964), 0.5404, abs_tol=2e-3)


def test_pointcloud_roundtrip():
    dec = build_decoder("sensor_msgs/msg/PointCloud2", SCHEMAS["sensor_msgs/msg/PointCloud2"])
    src = np.array([(1.0, 2.0, 0.0, 183.0), (4.35, -1.04, 0.0, 412.0)], dtype="<f4")
    msg = dec(encode_points(src))
    assert msg.width == 2 and msg.point_step == 16 and [f.name for f in msg.fields] == ["x", "y", "z", "voc"]
    pts = points_from_pointcloud(msg)
    assert pts.shape == (2, 4)
    np.testing.assert_allclose(pts, src)


def test_empty_pointcloud():
    dec = build_decoder("sensor_msgs/msg/PointCloud2", SCHEMAS["sensor_msgs/msg/PointCloud2"])
    assert points_from_pointcloud(dec(encode_points(np.zeros((0, 4), "<f4")))).shape == (0, 4)


def test_map_roundtrip():
    dec = build_decoder("nav_msgs/msg/OccupancyGrid", SCHEMAS["nav_msgs/msg/OccupancyGrid"])
    grid = np.full((3, 4), -1, dtype=np.int8)
    grid[1, 2] = 100; grid[0, 0] = 0
    g = map_from_msg(dec(encode_map(grid)))
    assert (g.width, g.height) == (4, 3) and math.isclose(g.resolution, 0.05, rel_tol=1e-6)
    assert g.origin_x == -1.0 and g.data[1, 2] == 100 and g.data[0, 0] == 0 and g.data[2, 3] == -1
    assert math.isclose(g.free_area_m2, 0.0025, rel_tol=1e-5)
