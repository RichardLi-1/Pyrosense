"""Runtime settings, read once from the environment (and backend/.env if present)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

TOPIC_POSE = "/pose"
TOPIC_VOC_POINTS = "/voc_points"
TOPIC_MAP = "/map"
TOPIC_VOC = "/voc"  # raw sensor frame: TVOC, eCO2, raw signals, warm-up
TOPICS = frozenset({TOPIC_POSE, TOPIC_VOC_POINTS, TOPIC_MAP, TOPIC_VOC})

CELL_SIZE_M = 0.2  # must match voc_cells in db/schema.sql


def _env(name: str, default: str) -> str:
    v = os.environ.get(name)
    return default if v is None or v == "" else v


def auto_session() -> str:
    return "live-" + datetime.now(timezone.utc).strftime("%Y%m%d-%H%M")


@dataclass
class Settings:
    bridge_url: str = field(default_factory=lambda: _env("BRIDGE_URL", "ws://localhost:8765"))
    database_url: str | None = field(default_factory=lambda: os.environ.get("DATABASE_URL") or None)
    gemini_api_key: str | None = field(default_factory=lambda: os.environ.get("GEMINI_API_KEY") or None)
    gemini_model: str = field(default_factory=lambda: _env("GEMINI_MODEL", "gemini-2.5-flash"))
    session: str = field(default_factory=lambda: _env("SESSION", auto_session()))
    voc_unit: str = field(default_factory=lambda: _env("VOC_UNIT", "ppb"))  # ppb (SGP30 TVOC) | index (SGP40)
    voc_threshold: float = field(default_factory=lambda: float(_env("VOC_THRESHOLD", "2200")))
    voc_hold_seconds: float = field(default_factory=lambda: float(_env("VOC_HOLD_SECONDS", "5")))
    alert_cooldown_seconds: float = field(default_factory=lambda: float(_env("ALERT_COOLDOWN_SECONDS", "60")))
    db_flush_seconds: float = field(default_factory=lambda: float(_env("DB_FLUSH_SECONDS", "1.0")))
    db_max_buffer_rows: int = field(default_factory=lambda: int(_env("DB_MAX_BUFFER_ROWS", "50000")))
    live_pose_hz: float = field(default_factory=lambda: float(_env("LIVE_POSE_HZ", "10")))
    voc_window_seconds: float = 60.0
    heatmap_default_half_life: float = 120.0
    summary_cache_seconds: float = 60.0
