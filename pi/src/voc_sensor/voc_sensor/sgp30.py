"""Sensirion SGP30 over raw I2C (smbus2). No Blinka dependency.

Datasheet commands used:
  0x2003 iaq_init           (10 ms)
  0x2008 measure_iaq        -> eCO2 ppm, TVOC ppb       (12 ms)
  0x2050 measure_raw        -> raw H2, raw ethanol      (25 ms)
  0x3682 get_serial_id      -> 48-bit serial
Each 16-bit word is followed by a CRC-8 (poly 0x31, init 0xFF).
"""
from __future__ import annotations

import math
import random
import time
from dataclasses import dataclass

ADDR = 0x58
CMD_INIT = (0x20, 0x03)
CMD_MEASURE = (0x20, 0x08)
CMD_RAW = (0x20, 0x50)
CMD_SERIAL = (0x36, 0x82)


def crc8(data: bytes) -> int:
    crc = 0xFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = ((crc << 1) ^ 0x31) & 0xFF if crc & 0x80 else (crc << 1) & 0xFF
    return crc


def parse_words(buf: bytes) -> list[int]:
    """Split a response into 16-bit words, verifying each CRC."""
    if len(buf) % 3:
        raise ValueError(f"response length {len(buf)} is not a multiple of 3")
    words = []
    for i in range(0, len(buf), 3):
        word, crc = buf[i:i + 2], buf[i + 2]
        if crc8(word) != crc:
            raise ValueError(f"CRC mismatch on word {i // 3}")
        words.append((word[0] << 8) | word[1])
    return words


@dataclass(slots=True)
class Sample:
    voc: float
    eco2: float
    raw_h2: float
    raw_ethanol: float
    unit: str = "ppb"


class Sgp30:
    """Minimal SGP30 driver. `bus` must provide i2c_rdwr(); smbus2.SMBus does."""

    def __init__(self, bus, addr: int = ADDR) -> None:
        self.bus = bus
        self.addr = addr
        self.serial = 0
        self.unit = "ppb"

    def _cmd(self, cmd: tuple[int, int], n_read: int, delay_s: float) -> bytes:
        from smbus2 import i2c_msg  # imported here so tests can inject a fake bus
        self.bus.i2c_rdwr(i2c_msg.write(self.addr, list(cmd)))
        time.sleep(delay_s)
        if n_read == 0:
            return b""
        rd = i2c_msg.read(self.addr, n_read)
        self.bus.i2c_rdwr(rd)
        return bytes(rd)

    def begin(self) -> None:
        w = parse_words(self._cmd(CMD_SERIAL, 9, 0.001))
        self.serial = (w[0] << 32) | (w[1] << 16) | w[2]
        self._cmd(CMD_INIT, 0, 0.010)

    def read(self) -> Sample:
        eco2, tvoc = parse_words(self._cmd(CMD_MEASURE, 6, 0.012))
        h2, eth = parse_words(self._cmd(CMD_RAW, 6, 0.025))
        return Sample(float(tvoc), float(eco2), float(h2), float(eth))


class FakeSensor:
    """Synthetic SGP30: slow baseline wander plus a spike while /tmp/voc_spike exists."""

    def __init__(self, spike_file: str = "/tmp/voc_spike") -> None:
        self.t0 = time.monotonic()
        self.serial = 0xFA4E
        self.unit = "ppb"
        self.spike_file = spike_file

    def begin(self) -> None:
        pass

    def read(self) -> Sample:
        import os
        t = time.monotonic() - self.t0
        base = 120 + 60 * math.sin(t / 40)
        spike = 2500 if os.path.exists(self.spike_file) else 0
        tvoc = max(0.0, base + spike + random.gauss(0, 8))
        return Sample(tvoc, 400 + tvoc * 0.3, 13000 - tvoc, 18000 - tvoc * 2)


def open_sensor(chip: str, i2c_bus: int = 1):
    if chip == "fake":
        return FakeSensor()
    if chip == "sgp30":
        from smbus2 import SMBus
        return Sgp30(SMBus(i2c_bus))
    raise ValueError(f"unsupported chip {chip!r} (sgp30 | fake)")
