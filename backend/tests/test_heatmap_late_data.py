"""Rows that arrive late must still reach /heatmap with the real refresh policy in place.

Late rows happen after a DB outage (the write buffer flushes a backlog), on replay of a
recorded walk, or when the Pi clock was wrong. voc_cells is real-time only *above* the
refresh watermark; below it, rows appear once a policy refresh covers their bucket.
"""
from datetime import datetime, timedelta, timezone

import asyncpg
import pytest

from app.db import Database


async def run_refresh_policy(conn):
    job = await conn.fetchval(
        "SELECT job_id FROM timescaledb_information.jobs "
        "WHERE proc_name = 'policy_refresh_continuous_aggregate' AND hypertable_name = 'voc_cells'")
    assert job is not None, "voc_cells has no refresh policy"
    await conn.execute(f"CALL run_job({job})")


@pytest.fixture
async def db(pg_url_with_policy):
    d = Database(pg_url_with_policy)
    await d._connect()
    yield d
    await d.stop()


@pytest.mark.parametrize("late_by", [timedelta(minutes=20), timedelta(hours=3), timedelta(days=2)])
async def test_late_rows_reach_heatmap(db, late_by):
    session = f"late-{int(late_by.total_seconds())}"
    conn = await asyncpg.connect(db.url)
    try:
        now = await conn.fetchval("SELECT now()")
        live = now - timedelta(minutes=1)
        late = now - late_by
        db.add_readings([(live, session, 0.1, 0.1, None, 100.0)])
        await db.flush_now()
        await run_refresh_policy(conn)                  # watermark moves up to ~now
        db.add_readings([(late, session, 5.1, 5.1, None, 300.0)])
        await db.flush_now()
        await run_refresh_policy(conn)                  # what the scheduler does every 10 s
        cells = {(c["cx"], c["cy"]) for c in await db.heatmap(session, now, half_life=1e9)}
        assert cells == {(0, 0), (25, 25)}, f"row {late_by} late is missing from the heat map"
        assert (await db.session_stats(session))["n"] == 2   # raw table always has it
    finally:
        await conn.close()
