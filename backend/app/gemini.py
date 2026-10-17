"""Walk summary: top VOC cells + a heat PNG -> short plain-English report via Gemini.

Falls back to a deterministic template when no key is configured or the call fails,
so the dashboard panel always has text.
"""
from __future__ import annotations

import asyncio
import io
import logging
import time
from datetime import datetime, timezone
from typing import Any

import numpy as np
from PIL import Image

from .config import CELL_SIZE_M

log = logging.getLogger("gemini")

UNITS = {
    # unit: (label, bands good/moderate/poor upper bounds, colour-scale max)
    "ppb":   ("TVOC in ppb (SGP30)", (220.0, 660.0, 2200.0), 3000.0),
    "index": ("VOC index 0-500 (SGP40)", (100.0, 250.0, 400.0), 500.0),
}


def unit_info(unit: str):
    return UNITS.get(unit, UNITS["ppb"])


PROMPT = """You are summarising an indoor air-quality walk for a non-technical reader.
A person wore a VOC (volatile organic compound) sensor with a LiDAR mapper and walked a building.
The attached image is a heat map of the measured {label}; below {b0:.0f} is good, {b0:.0f}-{b1:.0f}
moderate, {b1:.0f}-{b2:.0f} poor, above {b2:.0f} is alert level. Brighter/redder = higher.
Session statistics and the ten highest-reading 20 cm cells (map coordinates in metres) follow.

{stats}

Top cells:
{cells}

Write at most 80 words. Say where (by coordinates, in metres) VOC was concentrated, how severe it
was on the scale above, whether it was brief or persistent, and one practical ventilation suggestion.
Do not mention that you are an AI and do not use bullet points."""

LUT = [(0.0, (0, 0, 0, 0)), (0.2, (0x1D, 0xD3, 0xB0, 255)), (0.5, (0xFF, 0xD1, 0x66, 255)),
       (0.75, (0xFF, 0x8C, 0x42, 255)), (1.0, (0xEF, 0x23, 0x3C, 255))]


def lut(v: float) -> tuple[int, int, int, int]:
    v = min(1.0, max(0.0, v))
    for (a, ca), (b, cb) in zip(LUT, LUT[1:]):
        if v <= b:
            f = 0.0 if b == a else (v - a) / (b - a)
            return tuple(int(round(ca[i] + (cb[i] - ca[i]) * f)) for i in range(4))  # type: ignore[return-value]
    return LUT[-1][1]


def render_heat_png(cells: list[dict[str, Any]], scale_max: float = 3000.0, px_per_cell: int = 6) -> bytes:
    """Cells -> RGBA PNG on a dark background, north-up, 1 cell = px_per_cell pixels."""
    if not cells:
        img = Image.new("RGBA", (64, 64), (0x0B, 0x0E, 0x14, 255))
    else:
        xs = [c["cx"] for c in cells]; ys = [c["cy"] for c in cells]
        x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
        w, h = (x1 - x0 + 3), (y1 - y0 + 3)
        rgba = np.zeros((h, w, 4), dtype=np.uint8)
        rgba[..., :3] = (0x0B, 0x0E, 0x14); rgba[..., 3] = 255
        wmax = max(c.get("weight", c.get("n", 1)) for c in cells) or 1.0
        for c in cells:
            r, g, b, _ = lut(c["mean"] / scale_max)
            a = min(1.0, c.get("weight", c.get("n", 1)) / wmax)
            col, row = c["cx"] - x0 + 1, c["cy"] - y0 + 1
            base = rgba[row, col, :3].astype(float)
            rgba[row, col, :3] = (base * (1 - a) + np.array((r, g, b)) * a).astype(np.uint8)
        img = Image.fromarray(rgba[::-1], "RGBA").resize((w * px_per_cell, h * px_per_cell), Image.NEAREST)
    out = io.BytesIO(); img.save(out, "PNG"); return out.getvalue()


def level(v: float, unit: str = "ppb") -> str:
    b0, b1, b2 = unit_info(unit)[1]
    return "good" if v < b0 else "moderate" if v < b1 else "poor" if v < b2 else "alert-level"


def fallback_text(stats: dict[str, Any], top: list[dict[str, Any]], unit: str = "ppb") -> str:
    if not top or not stats.get("n"):
        return "No readings recorded for this session yet. Walk the space with the sensor warmed up and the summary will describe where VOC concentrated."
    c = top[0]
    x, y = (c["cx"] + 0.5) * CELL_SIZE_M, (c["cy"] + 0.5) * CELL_SIZE_M
    peak = stats.get("peak") or c["mean"]
    mean = stats.get("mean") or 0.0
    u = "ppb" if unit == "ppb" else ""
    return (f"Across {stats['n']} readings over {stats.get('cells', 0)} map cells the average VOC level was "
            f"{mean:.0f} {u}({level(mean, unit)}). The highest concentration was around ({x:.1f}, {y:.1f}) m, "
            f"peaking at {peak:.0f} {u}({level(peak, unit)}). Consider increasing ventilation or checking for a "
            f"source near that spot, then re-walk the area to confirm it clears.").replace(" (", " (").replace("  ", " ")


class Summarizer:
    def __init__(self, api_key: str | None, model: str, cache_seconds: float = 60.0, unit: str = "ppb") -> None:
        self.api_key = api_key
        self.model = model
        self.unit = unit
        self.cache_seconds = cache_seconds
        self._cache: dict[str, tuple[float, dict[str, Any]]] = {}
        self._client = None
        if api_key:
            try:
                from google import genai
                self._client = genai.Client(api_key=api_key)
            except Exception as e:  # noqa: BLE001
                log.error("google-genai unavailable: %s", e)

    @property
    def enabled(self) -> bool:
        return self._client is not None

    async def summarize(self, session: str, stats: dict[str, Any], top: list[dict[str, Any]],
                        heat_cells: list[dict[str, Any]], force: bool = False) -> dict[str, Any]:
        now = time.time()
        cached = self._cache.get(session)
        if cached and not force and now - cached[0] < self.cache_seconds:
            return cached[1]
        png = render_heat_png(heat_cells or top, scale_max=unit_info(self.unit)[2])
        text, source = None, "fallback"
        if self._client is not None:
            try:
                text = (await asyncio.wait_for(self._call(stats, top, png), timeout=30)).strip()
            except Exception as e:  # noqa: BLE001
                log.warning("gemini failed, using fallback: %s", e)
        if text:
            source = "gemini"
        else:
            text = fallback_text(stats, top, self.unit)
        result = {"text": text.strip(), "source": source, "unit": self.unit,
                  "model": self.model if source == "gemini" else None,
                  "generated_at": datetime.now(timezone.utc).isoformat(), "top_cells": top, "stats": stats}
        self._cache[session] = (now, result)
        return result

    async def _call(self, stats: dict[str, Any], top: list[dict[str, Any]], png: bytes) -> str:
        from google.genai import types
        cells = "\n".join(
            f"- ({(c['cx'] + 0.5) * CELL_SIZE_M:.1f}, {(c['cy'] + 0.5) * CELL_SIZE_M:.1f}) m: "
            f"mean {c['mean']:.0f} over {c['n']} samples, {c['first_seen'][11:19]}–{c['last_seen'][11:19]} UTC"
            for c in top)
        label, (b0, b1, b2), _ = unit_info(self.unit)
        prompt = PROMPT.format(label=label, b0=b0, b1=b1, b2=b2,
                               stats="\n".join(f"{k}: {v}" for k, v in stats.items()), cells=cells or "(none)")
        resp = await self._client.aio.models.generate_content(  # type: ignore[union-attr]
            model=self.model,
            contents=[types.Part.from_bytes(data=png, mime_type="image/png"), prompt])
        return resp.text or ""
