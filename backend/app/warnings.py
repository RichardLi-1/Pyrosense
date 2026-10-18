"""Spoken warnings: when the live reading crosses WARN_THRESHOLD, write a short Gemini warning
and voice it with ElevenLabs, then push a `warning` event to /ws/live.

Rule: same shape as the exposure alert (threshold, hold, cooldown) but at a lower level, so the
wearer hears about moderate air before it becomes an alert. Everything degrades gracefully:
no Gemini key -> template text; no ElevenLabs key -> the dashboard uses the browser voice.
"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from collections import deque
from datetime import datetime, timezone
from typing import Any, Callable

import httpx

from .alerts import AlertEngine

log = logging.getLogger("warnings")

PROMPT = """You are the voice assistant of a wearable air-quality mapper worn by someone walking a building.
Write ONE spoken warning, at most 35 words, calm and specific, in plain English, no bullet points,
no emoji, no units other than "parts per billion" spoken once at most. Say what was detected, how
serious it is on this scale (below {b0:.0f} good, {b0:.0f}-{b1:.0f} moderate, {b1:.0f}-{b2:.0f} poor,
above {b2:.0f} hazardous), whether it is rising, and one short action.

Reading: {voc:.0f} {unit} TVOC ({level}), {trend}.
Position: x {x:.1f} m, y {y:.1f} m on the floor plan. eCO2: {eco2}. Exposure so far: {dose:.0f} {unit}-minutes.
"""

BANDS = {"ppb": (220.0, 660.0, 2200.0), "index": (100.0, 250.0, 400.0)}


def level_name(v: float, unit: str) -> str:
    b0, b1, b2 = BANDS.get(unit, BANDS["ppb"])
    return "good" if v < b0 else "moderate" if v < b1 else "poor" if v < b2 else "hazardous"


def fallback_text(ctx: dict[str, Any]) -> str:
    lvl = ctx["level"]
    action = {"good": "keep going", "moderate": "note the spot and keep moving",
              "poor": "limit time here and ventilate", "hazardous": "leave the area now"}[lvl]
    return (f"Warning. Volatile organic compounds at {ctx['voc']:.0f} parts per billion, {lvl}, {ctx['trend']}, "
            f"near {ctx['x']:.0f} by {ctx['y']:.0f} metres. {action.capitalize()}.")


class WarningEngine:
    def __init__(self, *, threshold: float, hold_seconds: float, cooldown_seconds: float, unit: str,
                 gemini_client, gemini_model: str, eleven_key: str | None, eleven_voice: str, eleven_model: str,
                 publish: Callable[[dict[str, Any]], None]) -> None:
        self.rule = AlertEngine(threshold, hold_seconds, cooldown_seconds)
        self.unit = unit
        self.gemini = gemini_client
        self.gemini_model = gemini_model
        self.eleven_key = eleven_key
        self.eleven_voice = eleven_voice
        self.eleven_model = eleven_model
        self.publish = publish
        self.recent: deque[dict[str, Any]] = deque(maxlen=20)
        self.audio: dict[str, bytes] = {}
        self._tasks: set[asyncio.Task] = set()

    @property
    def threshold(self) -> float:
        return self.rule.threshold

    def reset(self) -> None:
        self.rule.reset()

    def observe(self, voc: float, ctx_fn: Callable[[], dict[str, Any]]) -> None:
        """Feed one live reading (cheap). Fires the slow Gemini/TTS work in the background."""
        if self.rule.update(voc, time.time()):
            ctx = ctx_fn()
            t = asyncio.create_task(self._fire(ctx))
            self._tasks.add(t)
            t.add_done_callback(self._tasks.discard)

    async def _fire(self, ctx: dict[str, Any]) -> None:
        wid = uuid.uuid4().hex[:10]
        ctx["level"] = level_name(ctx["voc"], self.unit)
        text, source = None, "fallback"
        if self.gemini is not None:
            try:
                text = await asyncio.wait_for(self._gemini(ctx), timeout=12)
                source = "gemini"
            except Exception as e:  # noqa: BLE001
                log.warning("gemini warning failed: %s", e)
        if not text:
            text = fallback_text(ctx)
        audio_url = None
        if self.eleven_key:
            try:
                mp3 = await asyncio.wait_for(self._tts(text), timeout=20)
                if mp3:
                    self.audio[wid] = mp3
                    if len(self.audio) > 20:
                        self.audio.pop(next(iter(self.audio)))
                    audio_url = f"/warnings/{wid}/audio.mp3"
            except Exception as e:  # noqa: BLE001
                log.warning("elevenlabs tts failed: %s", e)
        ev = {"t": "warning", "id": wid, "ts": datetime.now(timezone.utc).isoformat(), "voc": ctx["voc"],
              "unit": self.unit, "level": ctx["level"], "x": ctx["x"], "y": ctx["y"], "text": text.strip(),
              "source": source, "audio_url": audio_url, "voice": "elevenlabs" if audio_url else "browser"}
        self.recent.appendleft(ev)
        log.warning("WARNING voc=%.0f (%s): %s", ctx["voc"], source, text.strip()[:90])
        self.publish(ev)

    async def _gemini(self, ctx: dict[str, Any]) -> str:
        b0, b1, b2 = BANDS.get(self.unit, BANDS["ppb"])
        prompt = PROMPT.format(b0=b0, b1=b1, b2=b2, voc=ctx["voc"], unit=self.unit, level=ctx["level"],
                               trend=ctx["trend"], x=ctx["x"], y=ctx["y"], eco2=ctx.get("eco2") or "unknown",
                               dose=ctx.get("dose") or 0.0)
        resp = await self.gemini.aio.models.generate_content(model=self.gemini_model, contents=prompt)
        return (resp.text or "").strip()

    async def _tts(self, text: str) -> bytes:
        url = f"https://api.elevenlabs.io/v1/text-to-speech/{self.eleven_voice}?output_format=mp3_44100_64"
        async with httpx.AsyncClient(timeout=20) as c:
            r = await c.post(url, headers={"xi-api-key": self.eleven_key, "accept": "audio/mpeg"},
                             json={"text": text, "model_id": self.eleven_model,
                                   "voice_settings": {"stability": 0.5, "similarity_boost": 0.75}})
            r.raise_for_status()
            return r.content


def trend_words(window: list[tuple[float, float]]) -> str:
    """'rising quickly' / 'rising' / 'steady' / 'falling' from the last 60 s of (unix s, voc)."""
    if len(window) < 4:
        return "just detected"
    half = len(window) // 2
    a = sum(v for _, v in window[:half]) / half
    b = sum(v for _, v in window[half:]) / (len(window) - half)
    if b > a * 1.5 and b - a > 50:
        return "rising quickly"
    if b > a * 1.1:
        return "rising"
    if b < a * 0.9:
        return "falling"
    return "steady"
