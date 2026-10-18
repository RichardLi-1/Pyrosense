"""Restart and save without a DB or Pi: restart still opens a new session and reports the Pi failure."""
import pytest
from httpx import ASGITransport, AsyncClient

from app.config import Settings
from app.main import create_app

pytestmark = pytest.mark.asyncio


async def test_restart_without_pi_or_db():
    app = create_app(Settings(database_url=None, gemini_api_key=None, session="walk-1",
                              bridge_url="ws://127.0.0.1:1", pi_control_url="http://127.0.0.1:1"), connect_bridge=False)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            r = await c.post("/session/restart", json={"name": "Lab Walk #2"})
            body = r.json()
            assert r.status_code == 200 and body["session"] == "lab-walk-2" and body["previous"] == "walk-1"
            assert body["pi"]["ok"] is False and body["pi"]["error"]
            assert (await c.get("/session")).json()["session"] == "lab-walk-2"
            assert (await c.post("/session/save", json={"name": "x"})).status_code == 503
