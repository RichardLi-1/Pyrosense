"""Queries and DB-backed routes against a real TimescaleDB with db/schema.sql applied.
Skipped unless TEST_DATABASE_URL is set (see conftest.py). Each test uses its own session."""
import uuid
from datetime import datetime, timedelta, timezone

import numpy as np
import pytest
from httpx import ASGITransport, AsyncClient

from app.db import Database
from app.main import create_app
from tests.conftest import feed, make_settings, wait_for
from tools.fake_pi import encode_points

T0 = datetime(2026, 10, 17, 12, 0, 0, tzinfo=timezone.utc)  # on a 10 s bucket boundary


@pytest.fixture
def session():
    return "t-" + uuid.uuid4().hex[:8]


@pytest.fixture
async def db(pg_url):
    d = Database(pg_url)
    await d._connect()
    yield d
    await d.stop()


async def write(db, session, readings):
    """readings: (seconds after T0, x, y, voc)"""
    db.add_readings([(T0 + timedelta(seconds=s), session, x, y, 0.5, v) for s, x, y, v in readings])
    await db.flush_now()


async def test_trail_orders_filters_and_limits(db, session):
    await write(db, session, [(2, 1.0, 1.0, 20), (0, 0.0, 0.0, 10), (4, 2.0, 2.0, 30)])
    await write(db, "other-" + session, [(1, 9.0, 9.0, 99)])
    trail = await db.trail(session, None, None)
    assert [p["voc"] for p in trail] == [10, 20, 30]
    assert trail[0] == {"ts": T0.isoformat(), "x": 0.0, "y": 0.0, "heading": 0.5, "voc": 10.0}
    assert [p["voc"] for p in await db.trail(session, T0 + timedelta(seconds=1), T0 + timedelta(seconds=3))] == [20]
    assert len(await db.trail(session, None, None, limit=2)) == 2


async def test_sessions_lists_span_and_count(db, session):
    await write(db, session, [(0, 0, 0, 1), (30, 0, 0, 2)])
    s = next(s for s in await db.sessions() if s["session"] == session)
    assert s == {"session": session, "started": T0.isoformat(),
                 "ended": (T0 + timedelta(seconds=30)).isoformat(), "n": 2}


async def test_heatmap_cells_and_decay(db, session):
    # Cell (5, 10): two readings in bucket T0, one in bucket T0+10s. Cell (0, 0): one reading at T0.
    await write(db, session, [(1, 1.05, 2.05, 100), (2, 1.15, 2.15, 200), (11, 1.1, 2.1, 300),
                              (3, 0.1, 0.1, 50)])
    until = T0 + timedelta(seconds=10)
    cells = {(c["cx"], c["cy"]): c for c in await db.heatmap(session, until, half_life=10)}
    assert set(cells) == {(5, 10), (0, 0)}
    c = cells[(5, 10)]
    # bucket T0 weight 0.5 (one half-life old), bucket T0+10 weight 1
    assert c["mean"] == pytest.approx((150 * 2 * 0.5 + 300 * 1) / 2) and c["weight"] == pytest.approx(2)
    assert c["n"] == 3 and c["sd"] > 0
    assert cells[(0, 0)]["mean"] == pytest.approx(50) and cells[(0, 0)]["sd"] == 0
    # `until` excludes later buckets
    early = await db.heatmap(session, T0 + timedelta(seconds=5), half_life=10)
    assert {(c["cx"], c["cy"]): c["n"] for c in early} == {(5, 10): 2, (0, 0): 1}


async def test_heatmap_sd_is_pooled_across_buckets(db, session):
    await write(db, session, [(0, 0.1, 0.1, 100), (10, 0.1, 0.1, 300)])
    [c] = await db.heatmap(session, T0 + timedelta(seconds=10), half_life=1e9)  # no decay
    assert c["mean"] == pytest.approx(200) and c["sd"] == pytest.approx(100, rel=1e-3)


async def test_top_cells_and_stats(db, session):
    await write(db, session, [(0, 0.1, 0.1, 50), (1, 1.1, 1.1, 400), (12, 1.1, 1.1, 300)])
    top = await db.top_cells(session, 10)
    assert [(c["cx"], c["cy"]) for c in top] == [(5, 5), (0, 0)]
    assert top[0]["mean"] == pytest.approx(350) and top[0]["n"] == 2
    assert top[0]["first_seen"] == T0.isoformat() and top[0]["last_seen"] == (T0 + timedelta(seconds=10)).isoformat()
    assert len(await db.top_cells(session, 1)) == 1
    st = await db.session_stats(session)
    assert st["n"] == 3 and st["cells"] == 2 and st["peak"] == 400 and st["mean"] == pytest.approx(250)
    empty = await db.session_stats("nobody-" + session)
    assert empty == {"n": 0, "started": None, "ended": None, "mean": None, "peak": None, "cells": 0}


async def test_alerts_roundtrip(db, session):
    a = await db.insert_alert(T0, session, 1.0, 2.0, 400, b"\x89PNG..", (-1.0, -2.0), 0.05)
    b = await db.insert_alert(T0 + timedelta(seconds=5), session, None, None, 300, None, None, None)
    listed = await db.alerts(session)
    assert [x["id"] for x in listed] == [b, a]  # newest first
    assert listed[1]["map_png_url"] == f"/alerts/{a}/map.png" and listed[1]["map_origin"] == [-1.0, -2.0]
    assert listed[0]["map_png_url"] is None and listed[0]["map_origin"] is None
    assert await db.alert_png(a) == b"\x89PNG.." and await db.alert_png(b) is None


async def test_routes_end_to_end(pg_url, session):
    app = create_app(make_settings(database_url=pg_url, session=session, voc_threshold=250,
                                   db_flush_seconds=0.05), connect_bridge=False)
    async with app.router.lifespan_context(app):
        await wait_for(lambda: app.state.db.connected)
        t = T0.timestamp()
        await feed(app, "/voc_points", "sensor_msgs/msg/PointCloud2",
                   encode_points(np.array([(1.1, 2.1, 0, 120), (1.1, 2.1, 0, 400)], "<f4"), np.array([t, t + 1])))
        await wait_for(lambda: app.state.db.rows_written >= 2)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            until = (T0 + timedelta(seconds=5)).isoformat()
            trail = (await c.get("/trail", params={"until": until})).json()
            assert [p["voc"] for p in trail] == [120, 400]
            heat = (await c.get("/heatmap", params={"until": until})).json()
            assert heat["session"] == session and heat["cell_size"] == 0.2
            assert [(x["cx"], x["cy"], x["n"]) for x in heat["cells"]] == [(5, 10, 2)]
            assert session in [s["session"] for s in (await c.get("/sessions")).json()]
            [alert] = (await c.get("/alerts")).json()
            png = await c.get(alert["map_png_url"] or f"/alerts/{alert['id']}/map.png")
            assert alert["voc"] == 400 and png.status_code == 404  # no map yet -> no snapshot
            s = (await c.get("/summary")).json()
            assert s["source"] == "fallback" and s["stats"]["n"] == 2 and s["top_cells"][0]["cx"] == 5
            assert "(1.1, 2.1)" in s["text"]
            assert (await c.get("/trail", params={"session": "nobody"})).json() == []
            h = (await c.get("/health")).json()["db"]
            assert h["connected"] and h["written"] == 2 and h["pending"] == 0
