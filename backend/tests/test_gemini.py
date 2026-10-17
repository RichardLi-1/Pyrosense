from app.gemini import Summarizer, fallback_text, lut, render_heat_png


def test_lut_endpoints():
    assert lut(0)[3] == 0 and lut(1.0)[:3] == (0xEF, 0x23, 0x3C)
    assert lut(0.5)[:3] == (0xFF, 0xD1, 0x66)


def test_heat_png_renders():
    cells = [{"cx": 0, "cy": 0, "mean": 400, "weight": 5}, {"cx": 3, "cy": 2, "mean": 100, "weight": 1}]
    png = render_heat_png(cells)
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    assert render_heat_png([])[:4] == b"\x89PNG"


def test_fallback_text_mentions_location():
    s = fallback_text({"n": 10, "cells": 3, "mean": 120.0, "peak": 410.0},
                      [{"cx": 20, "cy": -5, "mean": 390.0, "n": 4}], unit="index")
    assert "(4.1, -0.9)" in s and "alert-level" in s
    s = fallback_text({"n": 10, "cells": 3, "mean": 120.0, "peak": 2500.0}, [{"cx": 0, "cy": 0, "mean": 2400.0, "n": 4}])
    assert "ppb" in s and "alert-level" in s and "(good)" in s


async def test_summarizer_without_key_uses_fallback_and_caches():
    s = Summarizer(None, "gemini-2.5-flash", cache_seconds=60)
    r1 = await s.summarize("s", {"n": 0}, [], [])
    r2 = await s.summarize("s", {"n": 5}, [], [])
    assert r1["source"] == "fallback" and r1 is r2


import io
from types import SimpleNamespace as NS

import numpy as np
import pytest
from PIL import Image

from app.gemini import level

TOP = [{"cx": 20, "cy": -5, "mean": 390.0, "n": 4, "first_seen": "2026-10-17T12:00:00+00:00",
        "last_seen": "2026-10-17T12:00:30+00:00"}]


class FakeModels:
    def __init__(self, text="  VOC was high near (4.1, -0.9).  ", error=None):
        self.text, self.error, self.calls = text, error, []

    async def generate_content(self, model, contents):
        self.calls.append((model, contents))
        if self.error:
            raise self.error
        return NS(text=self.text)


def with_fake(models):
    s = Summarizer(None, "gemini-test", cache_seconds=60)
    s._client = NS(aio=NS(models=models))
    return s


@pytest.mark.parametrize("v,name", [(0, "good"), (99.9, "good"), (100, "moderate"), (250, "poor"),
                                    (399, "poor"), (400, "alert-level")])
def test_level_boundaries(v, name):
    assert level(v, "index") == name


@pytest.mark.parametrize("v,name", [(0, "good"), (219, "good"), (220, "moderate"), (660, "poor"), (2200, "alert-level")])
def test_level_boundaries_ppb(v, name):
    assert level(v) == name


def test_fallback_without_readings():
    assert fallback_text({"n": 0}, []).startswith("No readings")


def test_heat_png_size_and_orientation():
    cells = [{"cx": 0, "cy": 0, "mean": 500, "weight": 1}, {"cx": 0, "cy": 1, "mean": 250, "weight": 1}]
    img = np.array(Image.open(io.BytesIO(render_heat_png(cells, scale_max=500.0, px_per_cell=1))))
    assert img.shape == (4, 3, 4)                        # 1 x 2 cells + 1-cell border
    assert tuple(img[2, 1, :3]) == (0xEF, 0x23, 0x3C)    # cy=0 (hot) is the lower cell: north-up
    assert tuple(img[1, 1, :3]) == (0xFF, 0xD1, 0x66)    # cy=1 above it
    assert tuple(img[0, 0, :3]) == (0x0B, 0x0E, 0x14)    # border is background


async def test_gemini_success_sends_image_and_cells():
    models = FakeModels()
    r = await with_fake(models).summarize("s", {"n": 4, "peak": 410}, TOP, [])
    assert r["source"] == "gemini" and r["model"] == "gemini-test" and r["text"] == "VOC was high near (4.1, -0.9)."
    model, (part, prompt) = models.calls[0]
    assert model == "gemini-test" and part.inline_data.mime_type == "image/png"
    assert "(4.1, -0.9) m: mean 390 over 4 samples, 12:00:00–12:00:30 UTC" in prompt and "peak: 410" in prompt


@pytest.mark.parametrize("models", [FakeModels(error=RuntimeError("quota")), FakeModels(text="")])
async def test_gemini_error_or_empty_falls_back(models):
    r = await with_fake(models).summarize("s", {"n": 4, "cells": 1, "mean": 300.0, "peak": 410.0}, TOP, [])
    assert r["source"] == "fallback" and r["model"] is None and "(4.1, -0.9)" in r["text"]


async def test_cache_is_per_session_and_force_bypasses():
    models = FakeModels()
    s = with_fake(models)
    a = await s.summarize("a", {"n": 1}, TOP, [])
    assert await s.summarize("a", {"n": 1}, TOP, []) is a
    await s.summarize("b", {"n": 1}, TOP, [])
    assert await s.summarize("a", {"n": 1}, TOP, [], force=True) is not a
    assert len(models.calls) == 3
