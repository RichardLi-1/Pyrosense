"""API behaviour without a database or bridge (the live path must work on its own)."""
import numpy as np
import pytest
from httpx import ASGITransport, AsyncClient

from app.config import Settings
from app.foxglove import build_decoder
from app.main import create_app
from app.ros_schemas import SCHEMAS
from tools.fake_pi import encode_map, encode_points, encode_pose

pytestmark = pytest.mark.asyncio


def make_settings(**kw):
    return Settings(database_url=None, gemini_api_key=None, session="test", voc_hold_seconds=0, **kw)


async def feed(app, topic, schema, payload):
    dec = build_decoder(schema, SCHEMAS[schema])
    await app.state.ingest.on_message(topic, dec(payload), 0)


async def test_health_and_map_flow():
    app = create_app(make_settings(), connect_bridge=False)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            r = await c.get("/health"); assert r.status_code == 200 and r.json()["session"] == "test"
            assert (await c.get("/map")).status_code == 404
            assert (await c.get("/heatmap")).status_code == 503
            grid = np.full((4, 5), -1, dtype=np.int8); grid[1, 1] = 0; grid[2, 2] = 100
            await feed(app, "/map", "nav_msgs/msg/OccupancyGrid", encode_map(grid))
            r = await c.get("/map")
            assert r.status_code == 200 and r.headers["content-type"] == "image/png"
            assert r.headers["x-map-origin"] == "-1.0,-1.0" and r.headers["x-map-size"] == "5,4"
            assert r.content[:8] == b"\x89PNG\r\n\x1a\n"
            meta = (await c.get("/map/meta")).json()
            assert meta["t"] == "map" and meta["w"] == 5 and meta["y_up"] is True


async def test_ws_live_streams_pose_voc_alert():
    app = create_app(make_settings(voc_threshold=250), connect_bridge=False)
    async with app.router.lifespan_context(app):
        q = app.state.bus.subscribe()
        await feed(app, "/pose", "geometry_msgs/msg/PoseWithCovarianceStamped", encode_pose(1.0, 2.0, 0.3))
        ev = q.get_nowait(); assert ev["t"] == "pose" and ev["x"] == 1.0
        await feed(app, "/voc_points", "sensor_msgs/msg/PointCloud2",
                   encode_points(np.array([(1, 2, 0, 120)], "<f4")))
        ev = q.get_nowait(); assert ev["t"] == "voc" and ev["voc"] == 120
        assert app.state.live.n_samples == 1
        await feed(app, "/voc_points", "sensor_msgs/msg/PointCloud2",
                   encode_points(np.array([(1, 2, 0, 120), (1.1, 2, 0, 400)], "<f4")))
        kinds = [q.get_nowait()["t"] for _ in range(q.qsize())]
        assert kinds == ["voc", "alert"]
        hello = app.state.live.hello_event(250)
        assert hello["session"] == "test" and hello["voc_window"][-1][1] == 400


async def test_ws_endpoint_hello():
    from starlette.testclient import TestClient
    app = create_app(make_settings(), connect_bridge=False)
    with TestClient(app) as client:
        with client.websocket_connect("/ws/live") as ws:
            hello = ws.receive_json()
            assert hello["t"] == "hello" and hello["threshold"] == 250.0


async def test_session_switch_resets():
    app = create_app(make_settings(), connect_bridge=False)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            await feed(app, "/voc_points", "sensor_msgs/msg/PointCloud2",
                       encode_points(np.array([(1, 2, 0, 120)], "<f4")))
            r = await c.post("/session", json={"session": "walk-2"})
            assert r.json()["session"] == "walk-2" and app.state.live.n_samples == 0
            assert (await c.get("/session")).json()["session"] == "walk-2"


async def test_summary_fallback_without_db_is_503():
    app = create_app(make_settings(), connect_bridge=False)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            assert (await c.get("/summary")).status_code == 503
