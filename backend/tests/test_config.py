import re

from app.config import Settings, auto_session


def test_defaults(monkeypatch):
    for k in ("BRIDGE_URL", "DATABASE_URL", "GEMINI_API_KEY", "SESSION", "VOC_THRESHOLD", "LIVE_POSE_HZ"):
        monkeypatch.delenv(k, raising=False)
    s = Settings()
    assert s.bridge_url == "ws://localhost:8765" and s.database_url is None and s.gemini_api_key is None
    assert s.voc_threshold == 2200.0 and s.voc_unit == "ppb" and s.live_pose_hz == 10.0
    assert re.fullmatch(r"live-\d{8}-\d{4}", s.session)


def test_env_overrides_and_blank_means_default(monkeypatch):
    monkeypatch.setenv("BRIDGE_URL", "ws://100.64.0.12:8765")
    monkeypatch.setenv("VOC_THRESHOLD", "180.5")
    monkeypatch.setenv("SESSION", "")           # .env.example leaves it blank
    monkeypatch.setenv("DATABASE_URL", "")
    s = Settings()
    assert s.bridge_url == "ws://100.64.0.12:8765" and s.voc_threshold == 180.5
    assert s.session.startswith("live-") and s.database_url is None


def test_auto_session_format():
    assert re.fullmatch(r"live-\d{8}-\d{4}", auto_session())
