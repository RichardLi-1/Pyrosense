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
                      [{"cx": 20, "cy": -5, "mean": 390.0, "n": 4}])
    assert "(4.1, -0.9)" in s and "alert-level" in s


async def test_summarizer_without_key_uses_fallback_and_caches():
    s = Summarizer(None, "gemini-2.5-flash", cache_seconds=60)
    r1 = await s.summarize("s", {"n": 0}, [], [])
    r2 = await s.summarize("s", {"n": 5}, [], [])
    assert r1["source"] == "fallback" and r1 is r2
