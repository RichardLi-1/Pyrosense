"""voc_mapper: places each /voc reading on the map and republishes the full set as
/voc_points (PointCloud2 x,y,z,voc in the map frame).

Sensor lag is corrected here: the pose used is map->base_link at (stamp - sensor_lag_seconds).

Parameters
  sensor_lag_seconds  float  (default 12.0)
  publish_period_s    float  (default 1.0)
  full_every_n        int    (default 30: republish the whole buffer every Nth tick; 0 = deltas only)
  max_points          int    (default 50000, ring buffer)
  map_frame           string (default map)
  base_frame          string (default base_link)
  tf_timeout_s        float  (default 0.2)
  pose_rate_hz        float  (default 10.0; 0 disables) publish map->base_link as /pose
Service
  /voc_mapper/reset   std_srvs/Trigger  -> clear the buffer (start of a session)

Also publishes /pose (geometry_msgs/PoseStamped, map frame) at pose_rate_hz from the tf tree, because
slam_toolbox only emits its own pose when the wearer has moved > minimum_travel_distance.

Bandwidth: each tick publishes only the points added since the last tick (plus a full republish
every `full_every_n` ticks so late subscribers such as Foxglove get the whole set). Every point
carries its own timestamp, so the backend de-duplicates exactly whichever form it receives.
"""
from __future__ import annotations

import time
from collections import deque

import rclpy
from rclpy.duration import Duration
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy, HistoryPolicy, DurabilityPolicy
from rclpy.time import Time
from std_srvs.srv import Trigger
from tf2_ros import Buffer, TransformListener, LookupException, ExtrapolationException, ConnectivityException

from geometry_msgs.msg import PoseStamped
from sensor_msgs.msg import PointCloud2
from voc_msgs.msg import VocReading

from .cloud import make_cloud_msg


class VocMapper(Node):
    def __init__(self) -> None:
        super().__init__("voc_mapper")
        self.declare_parameter("sensor_lag_seconds", 12.0)
        self.declare_parameter("publish_period_s", 1.0)
        self.declare_parameter("max_points", 50000)
        self.declare_parameter("map_frame", "map")
        self.declare_parameter("base_frame", "base_link")
        self.declare_parameter("tf_timeout_s", 0.2)
        self.declare_parameter("pose_rate_hz", 10.0)
        self.declare_parameter("full_every_n", 30)
        self.lag = float(self.get_parameter("sensor_lag_seconds").value)
        self.map_frame = self.get_parameter("map_frame").value
        self.base_frame = self.get_parameter("base_frame").value
        self.tf_timeout = Duration(seconds=float(self.get_parameter("tf_timeout_s").value))
        max_points = int(self.get_parameter("max_points").value)

        # keep enough tf history to look back `lag` seconds with margin
        self.tf_buffer = Buffer(cache_time=Duration(seconds=max(60.0, self.lag * 3)))
        self.tf_listener = TransformListener(self.tf_buffer, self, spin_thread=True)

        self.points: deque = deque(maxlen=max_points)
        self.pending: list = []  # points added since the last publish
        self.tick = 0
        self.full_every_n = int(self.get_parameter("full_every_n").value)
        self.dirty = False
        self.dropped = 0
        self.skipped_warmup = 0
        self._last_tf_warn = 0.0

        self.sub = self.create_subscription(VocReading, "/voc", self.on_voc, 10)
        qos = QoSProfile(reliability=ReliabilityPolicy.RELIABLE, history=HistoryPolicy.KEEP_LAST, depth=1,
                         durability=DurabilityPolicy.TRANSIENT_LOCAL)
        self.pub = self.create_publisher(PointCloud2, "/voc_points", qos)
        self.create_service(Trigger, "/voc_mapper/reset", self.on_reset)
        self.create_timer(float(self.get_parameter("publish_period_s").value), self.publish)
        self.create_timer(30.0, self.report)
        pose_hz = float(self.get_parameter("pose_rate_hz").value)
        self.pose_pub = self.create_publisher(PoseStamped, "/pose", 10)
        self._pose_warned = 0.0
        if pose_hz > 0:
            self.create_timer(1.0 / pose_hz, self.publish_pose)
        self.get_logger().info(f"lag={self.lag}s max_points={max_points} {self.map_frame}->{self.base_frame}")

    def on_voc(self, msg: VocReading) -> None:
        if not msg.warmed_up:
            self.skipped_warmup += 1
            return
        t_eff = Time.from_msg(msg.header.stamp) - Duration(seconds=self.lag)
        try:
            tf = self.tf_buffer.lookup_transform(self.map_frame, self.base_frame, t_eff, timeout=self.tf_timeout)
        except (LookupException, ExtrapolationException, ConnectivityException) as e:
            self.dropped += 1
            now = time.monotonic()
            if now - self._last_tf_warn > 5.0:
                self._last_tf_warn = now
                self.get_logger().warning(f"tf lookup failed ({self.dropped} dropped): {str(e)[:120]}")
            return
        p = tf.transform.translation
        t = msg.header.stamp.sec + msg.header.stamp.nanosec * 1e-9
        pt = (p.x, p.y, 0.0, float(msg.voc), t)
        self.points.append(pt)
        self.pending.append(pt)
        self.dirty = True

    def publish(self) -> None:
        self.tick += 1
        full = self.full_every_n > 0 and self.tick % self.full_every_n == 0
        if full and self.points:
            batch = list(self.points)
        elif self.pending:
            batch = self.pending
        else:
            return
        self.pub.publish(make_cloud_msg(batch, self.get_clock().now().to_msg(), self.map_frame))
        self.pending = []
        self.dirty = False

    def on_reset(self, _req, res):
        n = len(self.points)
        self.points.clear()
        self.pending = []
        self.dirty = True
        self.pub.publish(make_cloud_msg([], self.get_clock().now().to_msg(), self.map_frame))
        res.success = True
        res.message = f"cleared {n} points"
        self.get_logger().info(res.message)
        return res

    def publish_pose(self) -> None:
        try:
            tf = self.tf_buffer.lookup_transform(self.map_frame, self.base_frame, Time())
        except (LookupException, ExtrapolationException, ConnectivityException) as e:
            now = time.monotonic()
            if now - self._pose_warned > 10.0:
                self._pose_warned = now
                self.get_logger().info(f"no {self.map_frame}->{self.base_frame} yet: {str(e)[:80]}")
            return
        msg = PoseStamped()
        msg.header.stamp = tf.header.stamp
        msg.header.frame_id = self.map_frame
        msg.pose.position.x = tf.transform.translation.x
        msg.pose.position.y = tf.transform.translation.y
        msg.pose.position.z = tf.transform.translation.z
        msg.pose.orientation = tf.transform.rotation
        self.pose_pub.publish(msg)

    def report(self) -> None:
        self.get_logger().info(f"points={len(self.points)} dropped_tf={self.dropped} skipped_warmup={self.skipped_warmup}")


def main() -> None:
    rclpy.init()
    node = VocMapper()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.try_shutdown()
