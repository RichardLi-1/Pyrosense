"""voc_mapper: places each /voc reading on the map and republishes the full set as
/voc_points (PointCloud2 x,y,z,voc in the map frame).

Sensor lag is corrected here: the pose used is map->base_link at (stamp - sensor_lag_seconds).

Parameters
  sensor_lag_seconds  float  (default 12.0)
  publish_period_s    float  (default 1.0)
  max_points          int    (default 50000, ring buffer)
  map_frame           string (default map)
  base_frame          string (default base_link)
  tf_timeout_s        float  (default 0.2)
Service
  /voc_mapper/reset   std_srvs/Trigger  -> clear the buffer (start of a session)
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
        self.lag = float(self.get_parameter("sensor_lag_seconds").value)
        self.map_frame = self.get_parameter("map_frame").value
        self.base_frame = self.get_parameter("base_frame").value
        self.tf_timeout = Duration(seconds=float(self.get_parameter("tf_timeout_s").value))
        max_points = int(self.get_parameter("max_points").value)

        # keep enough tf history to look back `lag` seconds with margin
        self.tf_buffer = Buffer(cache_time=Duration(seconds=max(60.0, self.lag * 3)))
        self.tf_listener = TransformListener(self.tf_buffer, self, spin_thread=True)

        self.points: deque = deque(maxlen=max_points)
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
        self.points.append((p.x, p.y, 0.0, float(msg.voc)))
        self.dirty = True

    def publish(self) -> None:
        if not self.dirty and self.points:
            return
        if not self.points:
            return
        self.pub.publish(make_cloud_msg(self.points, self.get_clock().now().to_msg(), self.map_frame))
        self.dirty = False

    def on_reset(self, _req, res):
        n = len(self.points)
        self.points.clear()
        self.dirty = True
        self.pub.publish(make_cloud_msg([], self.get_clock().now().to_msg(), self.map_frame))
        res.success = True
        res.message = f"cleared {n} points"
        self.get_logger().info(res.message)
        return res

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
