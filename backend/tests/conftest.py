"""Shared helpers. DB tests need TEST_DATABASE_URL (any TimescaleDB server; `make test`
points it at the local dev db). They create a throwaway `hazard_test` database there."""
import asyncio
import os
import socket
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import asyncpg
import pytest

from app.config import Settings
from app.foxglove import build_decoder
from app.ros_schemas import SCHEMAS

SCHEMA_SQL = Path(__file__).resolve().parents[2] / "db" / "schema.sql"
TEST_DB = "hazard_test"


def make_settings(**kw):
    kw = {"database_url": None, "gemini_api_key": None, "session": "test", "voc_hold_seconds": 0, **kw}
    return Settings(**kw)


def decode(schema: str, payload: bytes):
    return build_decoder(schema, SCHEMAS[schema])(payload)


async def feed(app, topic, schema, payload):
    await app.state.ingest.on_message(topic, decode(schema, payload), 0)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


async def wait_for(cond, timeout=5.0, step=0.02):
    for _ in range(int(timeout / step)):
        if cond():
            return
        await asyncio.sleep(step)
    raise AssertionError("timed out waiting for condition")


def _admin_url() -> str:
    admin = os.environ.get("TEST_DATABASE_URL")
    if not admin:
        pytest.skip("TEST_DATABASE_URL not set (make test sets it to the local db)")
    return admin


def _create_db(name: str, keep_policy: bool) -> str:
    admin = _admin_url()

    async def setup() -> str:
        try:
            conn = await asyncpg.connect(admin, timeout=3)
        except Exception as e:  # noqa: BLE001
            pytest.skip(f"no database at TEST_DATABASE_URL: {e}")
        await conn.execute(f"DROP DATABASE IF EXISTS {name} WITH (FORCE)")
        await conn.execute(f"CREATE DATABASE {name}")
        await conn.close()
        url = urlunsplit(urlsplit(admin)._replace(path="/" + name))
        conn = await asyncpg.connect(url)
        await conn.execute(SCHEMA_SQL.read_text())
        if not keep_policy:
            await conn.execute("SELECT remove_continuous_aggregate_policy('voc_cells')")
        await conn.close()
        return url

    return asyncio.run(setup())


@pytest.fixture(scope="session")
def pg_url():
    """No background refresh: voc_cells stays fully real-time, so results don't depend
    on when the policy job last ran. Tests may use any timestamps."""
    return _create_db(TEST_DB, keep_policy=False)


@pytest.fixture(scope="session")
def pg_url_with_policy():
    """Schema exactly as deployed, refresh policy included. Separate database because a
    refresh moves the watermark, which would hide old-timestamp rows in other tests."""
    return _create_db(TEST_DB + "_policy", keep_policy=True)
