"""Spoken warnings: rule, fallbacks and the event shape, with Gemini/ElevenLabs faked."""
import asyncio
from types import SimpleNamespace as NS

import pytest

from app.config import Settings
from app.foxglove import build_decoder
from app.main import create_app
from app.ros_schemas import SCHEMAS
from app.warnings import WarningEngine, trend_words, level_name
from tools.fake_pi import encode_voc

pytestmark = pytest.mark.asyncio


def test_trend_and_levels():
    assert trend_words([]) == "just detected"
    assert trend_words([(0, 10), (1, 10), (2, 300), (3, 320)]) == "rising quickly"
    assert trend_words([(0, 100), (1, 100), (2, 60), (3, 60)]) == "falling"
    assert level_name(50, "ppb") == "good" and level_name(300, "ppb") == "moderate" and level_name(3000, "ppb") == "hazardous"


async def test_fallback_text_and_event_without_keys():
    got = []
    w = WarningEngine(threshold=100, hold_seconds=0, cooldown_seconds=90, unit="ppb", gemini_client=None,
                      gemini_model="x", eleven_key=None, eleven_voice="v", eleven_model="m", publish=got.append)
    w.observe(150, lambda: {"voc": 150, "x": 1.0, "y": 2.0, "eco2": 500, "trend": "rising", "dose": 12})
    await asyncio.sleep(0.05)
    assert got and got[0]["t"] == "warning" and got[0]["source"] == "fallback" and got[0]["voice"] == "browser"
    assert "150 parts per billion" in got[0]["text"] and got[0]["level"] == "good"  # 100 ppb trigger sits below the moderate band
    w.observe(160, lambda: {})  # cooldown: nothing
    await asyncio.sleep(0.02)
    assert len(got) == 1


async def test_gemini_and_tts_used_when_available():
    got = []

    class FakeModels:
        async def generate_content(self, model, contents):
            assert "parts per billion" in contents or "TVOC" in contents
            return NS(text="Heads up, moderate fumes ahead, rising. Keep moving.")
    gem = NS(aio=NS(models=FakeModels()))
    w = WarningEngine(threshold=100, hold_seconds=0, cooldown_seconds=0, unit="ppb", gemini_client=gem,
                      gemini_model="x", eleven_key="k", eleven_voice="v", eleven_model="m", publish=got.append)

    async def fake_tts(text):
        return b"ID3fakemp3"
    w._tts = fake_tts
    await w._fire({"voc": 300, "x": 0, "y": 0, "eco2": None, "trend": "rising", "dose": 0})
    ev = got[0]
    assert ev["source"] == "gemini" and ev["voice"] == "elevenlabs" and ev["audio_url"].endswith("/audio.mp3")
    assert w.audio[ev["id"]] == b"ID3fakemp3"


async def test_sensor_frame_triggers_warning_via_ingest():
    app = create_app(Settings(database_url=None, gemini_api_key=None, session="t", warn_hold_seconds=0),
                     connect_bridge=False)
    async with app.router.lifespan_context(app):
        q = app.state.bus.subscribe()
        dec = build_decoder("voc_msgs/msg/VocReading", SCHEMAS["voc_msgs/msg/VocReading"])
        await app.state.ingest.on_message("/voc", dec(encode_voc(240.0, True)), 0)
        await asyncio.sleep(0.05)
        kinds = [q.get_nowait()["t"] for _ in range(q.qsize())]
        assert kinds == ["sensor", "warning"]
