"""Minimal CDR (little-endian, XCDR1) writer for ROS 2 messages.

Only used by tools/fake_pi.py and the tests to produce byte-exact payloads the
way rmw_fastrtps / foxglove_bridge would. Decoding is done by mcap_ros2.
"""
from __future__ import annotations

import struct

ENCAPSULATION_LE = b"\x00\x01\x00\x00"


class CdrWriter:
    def __init__(self) -> None:
        self._buf = bytearray()

    def _align(self, n: int) -> None:
        pad = (-len(self._buf)) % n
        self._buf.extend(b"\x00" * pad)

    def _pack(self, fmt: str, *values: object) -> None:
        size = struct.calcsize(fmt)
        self._align(size)
        self._buf.extend(struct.pack("<" + fmt, *values))

    def bool(self, v: bool) -> "CdrWriter":
        self._pack("B", 1 if v else 0); return self
    def uint8(self, v: int) -> "CdrWriter":
        self._pack("B", v); return self
    def int8(self, v: int) -> "CdrWriter":
        self._pack("b", v); return self
    def int32(self, v: int) -> "CdrWriter":
        self._pack("i", v); return self
    def uint32(self, v: int) -> "CdrWriter":
        self._pack("I", v); return self
    def float32(self, v: float) -> "CdrWriter":
        self._pack("f", v); return self
    def float64(self, v: float) -> "CdrWriter":
        self._pack("d", v); return self

    def string(self, s: str) -> "CdrWriter":
        data = s.encode("utf-8") + b"\x00"
        self.uint32(len(data))
        self._buf.extend(data)
        return self

    def time(self, sec: int, nanosec: int) -> "CdrWriter":
        return self.int32(sec).uint32(nanosec)

    def header(self, sec: int, nanosec: int, frame_id: str) -> "CdrWriter":
        return self.time(sec, nanosec).string(frame_id)

    def bytes_seq(self, data: bytes) -> "CdrWriter":
        self.uint32(len(data))
        self._buf.extend(data)
        return self

    def float64_array(self, values) -> "CdrWriter":
        for v in values:
            self.float64(v)
        return self

    def pose(self, x: float, y: float, z: float, qx: float, qy: float, qz: float, qw: float) -> "CdrWriter":
        return self.float64_array((x, y, z, qx, qy, qz, qw))

    def finish(self) -> bytes:
        return ENCAPSULATION_LE + bytes(self._buf)
