"""Raw /voc frames reach the live stream as `sensor` events (eCO2, raw signals, warm-up)."""
import math

import pytest

from app.config import Settings
from app.foxglove import build_decoder
from app.main import create_app
from app.ros_schemas import SCHEMAS
from tools.fake_pi import encode_voc

pytestmark = pytest.mark.asyncio


def test_voc_reading_roundtrip():
    dec = build_decoder("voc_msgs/msg/VocReading", SCHEMAS["voc_msgs/msg/VocReading"])
    m = dec(encode_voc(183.0, True))
    assert m.header.frame_id == "voc_link" and m.unit == "ppb" and m.voc == 183.0
    assert m.eco2 == pytest.approx(400 + 183 * 0.3, rel=1e-5) and m.warmed_up is True
    assert math.isnan(m.temperature)


async def test_sensor_event_and_hello():
    app = create_app(Settings(database_url=None, gemini_api_key=None, session="t"), connect_bridge=False)
    async with app.router.lifespan_context(app):
        q = app.state.bus.subscribe()
        dec = build_decoder("voc_msgs/msg/VocReading", SCHEMAS["voc_msgs/msg/VocReading"])
        await app.state.ingest.on_message("/voc", dec(encode_voc(42.0, False)), 0)
        ev = q.get_nowait()
        assert ev["t"] == "sensor" and ev["voc"] == 42.0 and ev["unit"] == "ppb" and ev["warmed_up"] is False
        assert ev["temperature"] is None and ev["eco2"] == pytest.approx(412.6, rel=1e-4)
        hello = app.state.live.hello_event(2200, "ppb")
        assert hello["sensor"]["eco2"] == ev["eco2"]
