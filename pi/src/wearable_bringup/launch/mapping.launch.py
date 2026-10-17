"""Bring up the whole wearable stack.

  ros2 launch wearable_bringup mapping.launch.py session:=utsc-sw-14h
  ros2 launch wearable_bringup mapping.launch.py replay:=true use_sim_time:=true   # with `ros2 bag play --clock`

Arguments
  session       bag + log name; "auto" -> <hostname>-<UTC timestamp>
  replay        true: skip hardware drivers (lidar, voc_driver) and the bag recorder
  use_sim_time  true when replaying a bag with --clock
  chip          sgp30 | fake   (fake = synthetic VOC, no I2C needed)
  record        false to disable the bag recorder in live mode
  bridge_port   foxglove_bridge port (8765)
"""
import os
import socket
from datetime import datetime, timezone

import yaml
from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, ExecuteProcess, OpaqueFunction, LogInfo
from launch.conditions import IfCondition, UnlessCondition
from launch.substitutions import LaunchConfiguration, PythonExpression
from launch_ros.actions import Node

PKG = "wearable_bringup"


def static_tf(name: str, child: str, f: dict) -> Node:
    return Node(package="tf2_ros", executable="static_transform_publisher", name=f"static_tf_{child}",
                arguments=["--x", str(f["x"]), "--y", str(f["y"]), "--z", str(f["z"]),
                           "--yaw", str(f["yaw"]), "--pitch", str(f["pitch"]), "--roll", str(f["roll"]),
                           "--frame-id", "base_link", "--child-frame-id", child], output="screen")


def setup(context, *args, **kwargs):
    share = get_package_share_directory(PKG)
    cfg = lambda n: os.path.join(share, "config", n)  # noqa: E731
    session = LaunchConfiguration("session").perform(context)
    if session == "auto":
        session = f"{socket.gethostname()}-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}"
    use_sim_time = LaunchConfiguration("use_sim_time").perform(context).lower() == "true"
    replay = LaunchConfiguration("replay")
    sim = {"use_sim_time": use_sim_time}

    with open(cfg("frames.yaml")) as fh:
        frames = yaml.safe_load(fh)

    actions = [
        LogInfo(msg=f"session={session} use_sim_time={use_sim_time}"),
        static_tf("laser", "laser", frames["laser"]),
        static_tf("voc_link", "voc_link", frames["voc_link"]),

        Node(package="rplidar_ros", executable="rplidar_node", name="rplidar_node",
             parameters=[cfg("rplidar_c1.yaml"), sim], output="screen",
             condition=UnlessCondition(replay)),

        Node(package="rf2o_laser_odometry", executable="rf2o_laser_odometry_node", name="rf2o_laser_odometry_node",
             parameters=[cfg("rf2o.yaml"), sim], output="screen"),

        Node(package="slam_toolbox", executable="async_slam_toolbox_node", name="slam_toolbox",
             parameters=[cfg("slam_toolbox.yaml"), sim], output="screen"),

        Node(package="voc_sensor", executable="voc_driver", name="voc_driver",
             parameters=[cfg("voc.yaml"), sim, {"chip": LaunchConfiguration("chip"), "session": session}],
             output="screen", condition=UnlessCondition(replay)),

        Node(package="voc_sensor", executable="voc_mapper", name="voc_mapper",
             parameters=[cfg("voc.yaml"), sim], output="screen"),

        Node(package="foxglove_bridge", executable="foxglove_bridge", name="foxglove_bridge",
             parameters=[{"port": LaunchConfiguration("bridge_port"), "address": "0.0.0.0",
                          "send_buffer_limit": 50_000_000, "use_compression": False,
                          "topic_whitelist": [".*"], "num_threads": 2}, sim], output="screen"),

        ExecuteProcess(
            cmd=["ros2", "bag", "record", "-s", "mcap", "-o", f"/data/bags/{session}",
                 "/scan", "/tf", "/tf_static", "/voc", "/pose", "/map", "/voc_points", "/odom"],
            output="screen",
            condition=IfCondition(PythonExpression(["not ", replay, " and ", LaunchConfiguration("record")]))),
    ]
    return actions


def generate_launch_description():
    return LaunchDescription([
        DeclareLaunchArgument("session", default_value="auto"),
        DeclareLaunchArgument("replay", default_value="false"),
        DeclareLaunchArgument("use_sim_time", default_value="false"),
        DeclareLaunchArgument("chip", default_value="sgp30"),
        DeclareLaunchArgument("record", default_value="true"),
        DeclareLaunchArgument("bridge_port", default_value="8765"),
        OpaqueFunction(function=setup),
    ])
