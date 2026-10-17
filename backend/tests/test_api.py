"""API behaviour without a database or bridge (the live path must work on its own)."""
from datetime import datetime, timezone

import numpy as np
import pytest
from fastapi import HTTPException
from httpx import ASGITransport, AsyncClient
from starlette.testclient import TestClient

from app.api import _parse_ts
from app.main import create_app
from tests.conftest import feed, make_settings
from tools.fake_pi import encode_map, encode_points, encode_pose

POSE = "geometry_msgs/msg/PoseWithCovarianceStamped"
CLOUD = "sensor_msgs/msg/PointCloud2"
GRID = "nav_msgs/msg/OccupancyGrid"


@pytest.fixture
async def app():
    a = create_app(make_settings(voc_threshold=250), connect_bridge=False)
    async with a.router.lifespan_context(a):
        yield a


@pytest.fixture
async def client(app):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        yield c


def cloud(*rows):
    return encode_points(np.array(rows, "<f4"))


async def test_index_and_health(client):
    assert (await client.get("/")).json()["live"] == "/ws/live"
    h = (await client.get("/health")).json()
    assert h["ok"] is True and h["session"] == "test" and h["bridge_connected"] is False
    assert h["db"] == {"enabled": False, "connected": False, "pending": 0, "written": 0, "dropped": 0,
                       "last_error": None}
    assert h["has_map"] is False and h["gemini"] is False and h["n_samples"] == 0


async def test_map_flow(app, client):
    assert (await client.get("/map")).status_code == 404
    assert (await client.get("/map/meta")).status_code == 404
    grid = np.full((4, 5), -1, dtype=np.int8); grid[1, 1] = 0; grid[2, 2] = 100
    await feed(app, "/map", GRID, encode_map(grid))
    r = await client.get("/map")
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"
    assert r.headers["x-map-origin"] == "-1.0,-1.0" and r.headers["x-map-size"] == "5,4"
    assert r.headers["x-map-version"] == "1" and r.headers["cache-control"] == "no-store"
    assert r.content[:8] == b"\x89PNG\r\n\x1a\n"
    meta = (await client.get("/map/meta")).json()
    assert meta["t"] == "map" and meta["w"] == 5 and meta["y_up"] is True and meta["url"] == "/map?v=1"
    await feed(app, "/map", GRID, encode_map(grid))
    assert (await client.get("/map/meta")).json()["version"] == 2
    assert (await client.get("/map", params={"session": "test"})).status_code == 200
    assert (await client.get("/map", params={"session": "other"})).status_code == 404


@pytest.mark.parametrize("path", ["/heatmap", "/trail", "/sessions", "/alerts", "/alerts/1/map.png", "/summary"])
async def test_db_routes_are_503_without_db(client, path):
    r = await client.get(path)
    assert r.status_code == 503 and "database unavailable" in r.json()["detail"]


@pytest.mark.parametrize("path", ["/heatmap?until=yesterday", "/trail?since=nope", "/heatmap?half_life=0",
                                  "/trail?limit=200001"])
async def test_bad_query_params_are_422(client, path):
    assert (await client.get(path)).status_code == 422


def test_parse_ts():
    utc = timezone.utc
    assert _parse_ts(None, "x") is None and _parse_ts("", "x") is None
    assert _parse_ts("1760670000", "x") == datetime.fromtimestamp(1760670000, utc)
    assert _parse_ts("1760670000.5", "x") == datetime.fromtimestamp(1760670000.5, utc)
    assert _parse_ts("2026-10-17T12:00:00Z", "x") == datetime(2026, 10, 17, 12, tzinfo=utc)
    assert _parse_ts("2026-10-17T12:00:00", "x") == datetime(2026, 10, 17, 12, tzinfo=utc)  # naive = UTC
    assert _parse_ts("2026-10-17T14:00:00+02:00", "x") == datetime(2026, 10, 17, 12, tzinfo=utc)
    with pytest.raises(HTTPException) as e:
        _parse_ts("soon", "until")
    assert e.value.status_code == 422 and "until" in e.value.detail


async def test_live_stream_pose_voc_alert(app):
    q = app.state.bus.subscribe()
    await feed(app, "/pose", POSE, encode_pose(1.0, 2.0, 0.3))
    ev = q.get_nowait(); assert ev["t"] == "pose" and ev["x"] == 1.0
    await feed(app, "/voc_points", CLOUD, cloud((1, 2, 0, 120)))
    ev = q.get_nowait(); assert ev["t"] == "voc" and ev["voc"] == 120 and ev["n_new"] == 1
    await feed(app, "/voc_points", CLOUD, cloud((1, 2, 0, 120), (1.1, 2, 0, 400)))
    kinds = [q.get_nowait() for _ in range(q.qsize())]
    assert [k["t"] for k in kinds] == ["voc", "alert"]
    alert = kinds[1]
    assert alert["id"] is None and alert["map_png_url"] is None and alert["threshold"] == 250
    assert alert["x"] == pytest.approx(1.1)
    assert app.state.live.n_samples == 2
    assert app.state.live.hello_event(250)["voc_window"][-1][1] == 400


async def test_session_switch(app, client):
    q = app.state.bus.subscribe()
    await feed(app, "/voc_points", CLOUD, cloud((1, 2, 0, 120)))
    r = await client.post("/session", json={"session": "  walk-2 "})
    assert r.json()["session"] == "walk-2" and app.state.live.n_samples == 0
    assert (await client.get("/session")).json()["session"] == "walk-2"
    assert [q.get_nowait()["t"] for _ in range(q.qsize())] == ["voc", "hello"]
    # The Pi keeps publishing its full list: the old point must not land in the new session.
    await feed(app, "/voc_points", CLOUD, cloud((1, 2, 0, 120), (3, 3, 0, 90)))
    assert app.state.live.n_samples == 1
    assert (await client.post("/session", json={})).status_code == 422


def test_ws_live_sends_snapshot_then_stream():
    app = create_app(make_settings(), connect_bridge=False)
    with TestClient(app) as client:
        with client.websocket_connect("/ws/live") as ws:
            hello = ws.receive_json()
            assert hello["t"] == "hello" and hello["threshold"] == 2200.0 and hello["unit"] == "ppb" and hello["session"] == "test"
            client.portal.call(feed, app, "/pose", POSE, encode_pose(1.0, 2.0, 0.0))
            assert ws.receive_json()["t"] == "pose"
        client.portal.call(feed, app, "/map", GRID, encode_map(np.zeros((2, 2), np.int8)))
        with client.websocket_connect("/ws/live") as ws:  # late joiner gets hello, map, pose
            assert [ws.receive_json()["t"] for _ in range(3)] == ["hello", "map", "pose"]
        assert app.state.bus.n_clients == 0
