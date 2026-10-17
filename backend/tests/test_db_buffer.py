"""Database write buffer and failure handling, against a fake pool (no Postgres)."""
import asyncio
from contextlib import asynccontextmanager

import pytest

from app.db import Database, DatabaseUnavailable


class FakeConn:
    def __init__(self, pool):
        self.pool = pool

    async def copy_records_to_table(self, table, records, columns):
        await self.pool.during_copy()
        if self.pool.fail:
            raise ConnectionError("lost connection")
        self.pool.written.extend(records)


class FakePool:
    def __init__(self, fail=False):
        self.written, self.fail = [], fail
        self.during_copy = lambda: asyncio.sleep(0)

    @asynccontextmanager
    async def acquire(self):
        yield FakeConn(self)

    async def close(self):
        pass


def rows(*ids):
    return [(i, "s", 0.0, 0.0, None, float(i)) for i in ids]


def db_with(pool, cap=10):
    db = Database("postgresql://fake", max_buffer_rows=cap)
    db.pool = pool
    return db


def test_disabled_db_ignores_rows():
    db = Database(None)
    db.add_readings(rows(1, 2))
    assert db.pending == 0 and not db.enabled and not db.connected


def test_overflow_drops_oldest_and_counts():
    db = Database("postgresql://fake", max_buffer_rows=3)
    db.add_readings(rows(1, 2)); db.add_readings(rows(3, 4, 5))
    assert [r[0] for r in db._buf] == [3, 4, 5] and db.rows_dropped == 2


async def test_flush_writes_and_empties():
    pool = FakePool()
    db = db_with(pool)
    db.add_readings(rows(1, 2, 3))
    await db.flush_now()
    assert [r[0] for r in pool.written] == [1, 2, 3] and db.pending == 0 and db.rows_written == 3


async def test_rows_added_during_copy_are_kept_when_buffer_full():
    pool = FakePool()
    db = db_with(pool, cap=3)
    db.add_readings(rows(1, 2, 3))           # buffer full (e.g. after an outage)

    async def ingest_meanwhile():
        db.add_readings(rows(4, 5))
    pool.during_copy = ingest_meanwhile
    await db.flush_now()
    assert [r[0] for r in pool.written] == [1, 2, 3]
    assert [r[0] for r in db._buf] == [4, 5] and db.rows_dropped == 0


async def test_failed_flush_requeues_in_order_keeping_newest():
    pool = FakePool(fail=True)
    db = db_with(pool, cap=4)
    db.add_readings(rows(1, 2, 3))

    async def ingest_meanwhile():
        db.add_readings(rows(4, 5))
    pool.during_copy = ingest_meanwhile
    with pytest.raises(ConnectionError):
        await db.flush_now()
    assert [r[0] for r in db._buf] == [2, 3, 4, 5] and db.rows_dropped == 1 and db.rows_written == 0
    pool.fail, pool.during_copy = False, (lambda: asyncio.sleep(0))
    await db.flush_now()
    assert [r[0] for r in pool.written] == [2, 3, 4, 5]


async def test_writer_loop_reconnects_with_backoff(monkeypatch):
    db = Database("postgresql://fake", flush_seconds=0)
    attempts = []

    async def connect():
        attempts.append(1)
        if len(attempts) < 3:
            raise OSError("refused")
        db.pool = FakePool()
    monkeypatch.setattr(db, "_connect", connect)
    sleeps = []
    real_sleep = asyncio.sleep

    async def fast_sleep(s):
        sleeps.append(s); await real_sleep(0)
    monkeypatch.setattr("app.db.asyncio.sleep", fast_sleep)
    db.add_readings(rows(1))
    await db.start()
    for _ in range(50):
        if db.rows_written:
            break
        await real_sleep(0)
    await db.stop()
    assert len(attempts) == 3 and db.rows_written == 1 and db.last_error == "refused"
    assert sleeps[:2] == [1.0, 2.0]


async def test_queries_raise_unavailable_without_pool():
    db = Database("postgresql://fake")
    db.last_error = "timeout"
    with pytest.raises(DatabaseUnavailable, match="timeout"):
        await db.trail("s", None, None)
    assert await db.insert_alert(None, "s", 0, 0, 1, None, None, None) is None
