"""voc_driver: reads the SGP30 at rate_hz and publishes voc_msgs/VocReading on /voc.

Parameters
  chip            sgp30 | fake            (default sgp30)
  i2c_bus         int                     (default 1)
  rate_hz         float                   (default 2.0)
  warmup_seconds  float                   (default 15.0; SGP30 reports 0 for ~15 s after init)
  frame_id        string                  (default voc_link)
  session         string                  (informational, logged at start)
"""
from __future__ import annotations

import math
import time

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy, HistoryPolicy

from voc_msgs.msg import VocReading

from .sgp30 import open_sensor


class VocDriver(Node):
    def __init__(self) -> None:
        super().__init__("voc_driver")
        self.declare_parameter("chip", "sgp30")
        self.declare_parameter("i2c_bus", 1)
        self.declare_parameter("rate_hz", 2.0)
        self.declare_parameter("warmup_seconds", 15.0)
        self.declare_parameter("frame_id", "voc_link")
        self.declare_parameter("session", "")
        chip = self.get_parameter("chip").value
        self.frame_id = self.get_parameter("frame_id").value
        self.warmup = float(self.get_parameter("warmup_seconds").value)
        rate = float(self.get_parameter("rate_hz").value)

        self.sensor = open_sensor(chip, int(self.get_parameter("i2c_bus").value))
        self.sensor.begin()
        self.started = time.monotonic()
        self.n = 0
        self.errors = 0
        self.last_info = 0.0
        qos = QoSProfile(reliability=ReliabilityPolicy.RELIABLE, history=HistoryPolicy.KEEP_LAST, depth=10)
        self.pub = self.create_publisher(VocReading, "/voc", qos)
        self.timer = self.create_timer(1.0 / max(rate, 0.1), self.tick)
        self.get_logger().info(
            f"chip={chip} serial=0x{self.sensor.serial:x} rate={rate}Hz warmup={self.warmup}s "
            f"session={self.get_parameter('session').value or '-'}")

    def tick(self) -> None:
        stamp = self.get_clock().now().to_msg()  # stamp at the moment of the read
        try:
            s = self.sensor.read()
        except Exception as e:  # noqa: BLE001
            self.errors += 1
            if self.errors in (1, 10, 100) or self.errors % 1000 == 0:
                self.get_logger().error(f"sensor read failed ({self.errors}x): {e}")
            return
        msg = VocReading()
        msg.header.stamp = stamp
        msg.header.frame_id = self.frame_id
        msg.voc = s.voc
        msg.unit = s.unit
        msg.eco2 = s.eco2
        msg.raw_h2 = s.raw_h2
        msg.raw_ethanol = s.raw_ethanol
        msg.temperature = math.nan
        msg.humidity = math.nan
        msg.warmed_up = (time.monotonic() - self.started) >= self.warmup
        self.pub.publish(msg)
        self.n += 1
        self.get_logger().debug(f"voc={s.voc:.0f}{s.unit} eco2={s.eco2:.0f} warmed_up={msg.warmed_up}")
        now = time.monotonic()
        if now - self.last_info >= 30:
            self.last_info = now
            self.get_logger().info(f"voc={s.voc:.0f} {s.unit}  eco2={s.eco2:.0f} ppm  n={self.n} "
                                   f"errors={self.errors} warmed_up={msg.warmed_up}")


def main() -> None:
    rclpy.init()
    node = VocDriver()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.try_shutdown()
