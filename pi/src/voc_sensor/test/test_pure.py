"""Tests that run without ROS: SGP30 protocol parsing and PointCloud2 packing."""
import sys
import types

import numpy as np
import pytest

from voc_sensor.sgp30 import crc8, parse_words, Sgp30, FakeSensor
from voc_sensor.cloud import pack_points, POINT_STEP


def word(v: int) -> bytes:
    b = bytes([(v >> 8) & 0xFF, v & 0xFF])
    return b + bytes([crc8(b)])


def test_crc8_datasheet_example():
    # Sensirion datasheet: CRC of 0xBEEF is 0x92
    assert crc8(b"\xbe\xef") == 0x92


def test_parse_words_ok_and_bad_crc():
    assert parse_words(word(400) + word(183)) == [400, 183]
    bad = bytearray(word(400)); bad[2] ^= 0x01
    with pytest.raises(ValueError):
        parse_words(bytes(bad))


class FakeI2cMsg:
    def __init__(self, addr, data=None, n=0):
        self.addr, self.data, self.n, self.buf = addr, data, n, b""
    def __iter__(self):
        return iter(self.buf)


class FakeBus:
    """Answers SGP30 commands with canned words."""
    def __init__(self):
        self.last = None
        self.writes = []
    def i2c_rdwr(self, msg):
        if msg.data is not None:
            self.last = tuple(msg.data); self.writes.append(self.last); return
        if self.last == (0x36, 0x82):
            msg.buf = word(0x0000) + word(0x026E) + word(0x2694)
        elif self.last == (0x20, 0x08):
            msg.buf = word(412) + word(1234)
        elif self.last == (0x20, 0x50):
            msg.buf = word(13100) + word(18200)


def test_sgp30_driver_with_fake_bus(monkeypatch):
    # stand in for smbus2.i2c_msg
    fake = types.SimpleNamespace(i2c_msg=types.SimpleNamespace(
        write=lambda addr, data: FakeI2cMsg(addr, data=data),
        read=lambda addr, n: FakeI2cMsg(addr, n=n)))
    monkeypatch.setitem(sys.modules, "smbus2", fake)
    monkeypatch.setattr("time.sleep", lambda s: None)
    bus = FakeBus()
    s = Sgp30(bus)
    s.begin()
    assert s.serial == 0x026E2694
    assert (0x20, 0x03) in bus.writes  # iaq_init sent
    r = s.read()
    assert (r.eco2, r.voc, r.raw_h2, r.raw_ethanol, r.unit) == (412.0, 1234.0, 13100.0, 18200.0, "ppb")


def test_fake_sensor_spikes(tmp_path):
    f = tmp_path / "spike"
    s = FakeSensor(spike_file=str(f)); s.begin()
    assert s.read().voc < 1000
    f.write_text("")
    assert s.read().voc > 2000


def test_pack_points_layout():
    from voc_sensor.cloud import DTYPE
    data, n = pack_points([(1.0, 2.0, 0.0, 183.0, 1792281129.5), (4.35, -1.04, 0.0, 412.0, 1792281130.0)])
    assert n == 2 and len(data) == 2 * POINT_STEP == 48
    back = np.frombuffer(data, dtype=DTYPE)
    np.testing.assert_allclose(back["voc"], [183, 412])
    np.testing.assert_allclose(back["x"], [1, 4.35], rtol=1e-6)
    np.testing.assert_allclose(back["t"], [1792281129.5, 1792281130.0])  # float64 keeps sub-second precision
    assert pack_points([]) == (b"", 0)
