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
from launch.actions import DeclareLaunchArgument, EmitEvent, ExecuteProcess, OpaqueFunction, LogInfo, RegisterEventHandler
from launch.events import matches_action
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import LifecycleNode, Node
from launch_ros.event_handlers import OnStateTransition
from launch_ros.events.lifecycle import ChangeState
from lifecycle_msgs.msg import Transition

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
    replay = LaunchConfiguration("replay").perform(context).lower() == "true"
    record = LaunchConfiguration("record").perform(context).lower() == "true" and not replay
    sim = {"use_sim_time": use_sim_time}

    with open(cfg("frames.yaml")) as fh:
        frames = yaml.safe_load(fh)

    slam = LifecycleNode(package="slam_toolbox", executable="async_slam_toolbox_node", name="slam_toolbox",
                         namespace="", parameters=[cfg("slam_toolbox.yaml"), sim], output="screen",
                         remappings=[("pose", "/slam_pose")])

    bag_dir = f"/data/bags/{session}"
    if os.path.exists(bag_dir):
        bag_dir += "-" + datetime.now(timezone.utc).strftime("%H%M%S")

    actions = [
        LogInfo(msg=f"session={session} use_sim_time={use_sim_time} replay={replay} record={record}"),
        static_tf("laser", "laser", frames["laser"]),
        static_tf("voc_link", "voc_link", frames["voc_link"]),

        Node(package="rplidar_ros", executable="rplidar_node", name="rplidar_node",
             parameters=[cfg("rplidar_c1.yaml"), sim], output="screen"),

        Node(package="rf2o_laser_odometry", executable="rf2o_laser_odometry_node", name="rf2o_laser_odometry_node",
             parameters=[cfg("rf2o.yaml"), sim], output="screen"),

        slam,
        # slam_toolbox is a lifecycle node in Jazzy: configure, then activate once inactive
        EmitEvent(event=ChangeState(lifecycle_node_matcher=matches_action(slam),
                                    transition_id=Transition.TRANSITION_CONFIGURE)),
        RegisterEventHandler(OnStateTransition(
            target_lifecycle_node=slam, start_state="configuring", goal_state="inactive",
            entities=[LogInfo(msg="slam_toolbox configured, activating"),
                      EmitEvent(event=ChangeState(lifecycle_node_matcher=matches_action(slam),
                                                  transition_id=Transition.TRANSITION_ACTIVATE))])),

        Node(package="voc_sensor", executable="voc_driver", name="voc_driver",
             parameters=[cfg("voc.yaml"), sim, {"chip": LaunchConfiguration("chip"), "session": session}],
             output="screen"),

        Node(package="voc_sensor", executable="voc_mapper", name="voc_mapper",
             parameters=[cfg("voc.yaml"), sim], output="screen"),

        Node(package="foxglove_bridge", executable="foxglove_bridge", name="foxglove_bridge",
             parameters=[{"port": LaunchConfiguration("bridge_port"), "address": "0.0.0.0",
                          "send_buffer_limit": 50_000_000, "use_compression": False,
                          "topic_whitelist": [".*"], "num_threads": 2}, sim], output="screen"),

    ]
    if replay:  # drop hardware drivers; a bag provides /scan and /voc
        actions = [a for a in actions if not (isinstance(a, Node) and a._Node__node_name in ("rplidar_node", "voc_driver"))]
    if record:
        actions.append(ExecuteProcess(
            cmd=["ros2", "bag", "record", "-s", "mcap", "-o", bag_dir,
                 "/scan", "/tf", "/tf_static", "/voc", "/pose", "/map", "/voc_points", "/odom"],
            output="screen"))
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
