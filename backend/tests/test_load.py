"""Throughput at the Pi's 50 000-point ring-buffer cap, published as the full list at ~1 Hz.
Budgets are ~5-10x what a laptop needs, so they catch regressions (e.g. a per-point Python
loop) rather than machine speed. The DB part needs TEST_DATABASE_URL."""
import time
from datetime import datetime, timezone

import numpy as np
import pytest

from app.alerts import AlertEngine
from app.db import Database
from app.ingest import Ingest
from app.state import Broadcaster, LiveState, PointTracker
from tests.conftest import decode, make_settings
from tools.fake_pi import encode_points

N = 50_000
CLOUD = "sensor_msgs/msg/PointCloud2"


@pytest.fixture(scope="module")
def walk():
    rng = np.random.default_rng(0)
    pts = (rng.random((N + 1, 4)) * [10, 7, 0, 500]).astype("<f4")
    t = 1.76e9 + np.arange(N + 1) * 0.5
    return pts, t


def timed(fn, *a):
    t0 = time.perf_counter()
    out = fn(*a)
    return out, time.perf_counter() - t0


def make_ingest(db):
    s = make_settings(database_url="postgresql://unused")
    return Ingest(s, LiveState("load"), db, Broadcaster(), AlertEngine(1e9, 0, 0))


async def test_full_list_with_t_at_cap(walk):
    pts, t = walk
    ing = make_ingest(Database("postgresql://unused", max_buffer_rows=2 * N))
    first = decode(CLOUD, encode_points(pts[:N], t[:N]))
    nxt = decode(CLOUD, encode_points(pts[1:], t[1:]))      # ring buffer shifted by one reading
    t0 = time.perf_counter(); await ing.on_message("/voc_points", first, 0); join = time.perf_counter() - t0
    t0 = time.perf_counter(); await ing.on_message("/voc_points", nxt, 0); step = time.perf_counter() - t0
    assert ing.state.n_samples == N + 1 and ing.db.pending == N + 1
    assert join < 0.5, f"joining mid-walk took {join * 1e3:.0f} ms"
    assert step < 0.05, f"steady-state message took {step * 1e3:.0f} ms"


def test_decode_at_cap(walk):
    pts, t = walk
    payload = encode_points(pts[:N], t[:N])
    assert len(payload) > 24 * N
    _, dt = timed(decode, CLOUD, payload)
    assert dt < 0.1, f"decoding 1.2 MB took {dt * 1e3:.0f} ms"


def test_tracker_without_t_at_cap(walk):
    pts, _ = walk
    tr = PointTracker()
    tr.new_index(pts[:N])
    idx, dt = timed(tr.new_index, pts[1:])
    assert idx.tolist() == [N - 1]
    assert dt < 0.3, f"legacy ring-buffer diff took {dt * 1e3:.0f} ms (blocks the event loop)"


async def test_db_copies_a_full_buffer(pg_url, walk):
    pts, t = walk
    db = Database(pg_url, max_buffer_rows=N)
    await db._connect()
    try:
        session = f"load-{time.time_ns()}"
        db.add_readings([(datetime.fromtimestamp(ts, timezone.utc), session, float(x), float(y), None, float(v))
                         for (x, y, _z, v), ts in zip(pts[:N].tolist(), t[:N].tolist())])
        t0 = time.perf_counter()
        await db.flush_now()
        dt = time.perf_counter() - t0
        assert db.rows_written == N and db.pending == 0
        assert dt < 5, f"COPY of {N} rows took {dt:.1f} s (backlog after an outage)"
        assert (await db.session_stats(session))["n"] == N
    finally:
        await db.stop()
