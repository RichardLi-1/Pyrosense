"""Ingest glue: what each topic does to live state, the DB buffer, alerts and the bus."""
import logging
from datetime import datetime, timezone

import numpy as np
import pytest

from app.alerts import AlertEngine
from app.ingest import Ingest
from app.state import Broadcaster, LiveState
from tests.conftest import decode, make_settings
from tools.fake_pi import encode_map, encode_points, encode_pose

CLOUD = "sensor_msgs/msg/PointCloud2"
POSE = "geometry_msgs/msg/PoseWithCovarianceStamped"


class FakeDb:
    def __init__(self, alert_id=7, fail=False):
        self.rows, self.alerts, self.alert_id, self.fail = [], [], alert_id, fail

    def add_readings(self, rows):
        self.rows.extend(rows)

    async def insert_alert(self, *args):
        if self.fail:
            raise RuntimeError("db down")
        self.alerts.append(args)
        return self.alert_id


def make(db=None, threshold=250, **kw):
    s = make_settings(voc_threshold=threshold, **kw)
    state, bus = LiveState("s1"), Broadcaster()
    ing = Ingest(s, state, db or FakeDb(), bus, AlertEngine(threshold, 0, 60))
    return ing, state, bus, bus.subscribe()


def drain(q):
    return [q.get_nowait() for _ in range(q.qsize())]


async def points(ing, rows, times=None):
    arr = np.array(rows, "<f4").reshape(-1, 4)
    await ing.on_message("/voc_points", decode(CLOUD, encode_points(arr, times)), 0)


async def test_rows_use_per_point_times_and_current_heading():
    db = FakeDb()
    ing, state, _, q = make(db)
    await ing.on_message("/pose", decode(POSE, encode_pose(0, 0, 0.5)), 0)
    await points(ing, [(1, 2, 0, 100), (3, 4, 0, 110)], np.array([1760670000.0, 1760670001.5]))
    utc = timezone.utc
    assert db.rows == [(datetime.fromtimestamp(1760670000.0, utc), "s1", 1.0, 2.0, pytest.approx(0.5), 100.0),
                       (datetime.fromtimestamp(1760670001.5, utc), "s1", 3.0, 4.0, pytest.approx(0.5), 110.0)]
    ev = drain(q)[-1]
    assert ev == {"t": "voc", "ts": "2025-10-17T03:00:01.500000+00:00", "voc": 110.0, "n_new": 2, "x": 3.0, "y": 4.0}
    assert state.n_samples == 2 and state.voc == 110.0


async def test_rows_fall_back_to_header_stamp_and_no_heading():
    db = FakeDb()
    ing, *_ = make(db)
    before = datetime.now(timezone.utc).replace(microsecond=0)
    await points(ing, [(1, 2, 0, 100), (3, 4, 0, 110)])
    assert len({r[0] for r in db.rows}) == 1 and db.rows[0][0] >= before
    assert db.rows[0][4] is None


async def test_repeat_message_does_nothing():
    db = FakeDb()
    ing, state, _, q = make(db)
    times = np.array([1.0, 2.0])
    await points(ing, [(1, 2, 0, 100), (3, 4, 0, 110)], times)
    drain(q)
    await points(ing, [(1, 2, 0, 100), (3, 4, 0, 110)], times)
    assert len(db.rows) == 2 and drain(q) == [] and state.n_samples == 2


async def test_alert_persists_with_map_snapshot():
    db = FakeDb(alert_id=7)
    ing, state, _, q = make(db)
    await ing.on_message("/map", decode("nav_msgs/msg/OccupancyGrid", encode_map(np.zeros((2, 3), np.int8))), 0)
    await points(ing, [(1, 2, 0, 400)], np.array([5.0]))
    alert = drain(q)[-1]
    assert alert["t"] == "alert" and alert["id"] == 7 and alert["map_png_url"] == "/alerts/7/map.png"
    ts, session, x, y, voc, png, origin, res = db.alerts[0]
    assert (session, x, y, voc, origin) == ("s1", 1.0, 2.0, 400.0, (-1.0, -1.0))
    assert png[:4] == b"\x89PNG" and res == pytest.approx(0.05)


async def test_alert_still_published_when_db_fails(caplog):
    ing, _, _, q = make(FakeDb(fail=True))
    with caplog.at_level(logging.WARNING):
        await points(ing, [(1, 2, 0, 400)], np.array([5.0]))
    alert = drain(q)[-1]
    assert alert["t"] == "alert" and alert["id"] is None and alert["map_png_url"] is None
    assert "alert not persisted" in caplog.text


async def test_alert_uses_latest_point_only():
    ing, _, _, q = make()
    await points(ing, [(1, 2, 0, 900), (3, 4, 0, 100)], np.array([1.0, 2.0]))
    assert [e["t"] for e in drain(q)] == ["voc"]


async def test_pose_is_throttled_but_state_always_updates():
    ing, state, _, q = make(live_pose_hz=1)
    for x in (1, 2, 3):
        await ing.on_message("/pose", decode(POSE, encode_pose(x, 0, 0)), 0)
    evs = drain(q)
    assert [e["x"] for e in evs] == [1.0] and state.pose.x == 3.0


async def test_map_publishes_event_and_unknown_topic_ignored():
    ing, state, _, q = make()
    await ing.on_message("/map", decode("nav_msgs/msg/OccupancyGrid", encode_map(np.zeros((2, 2), np.int8))), 0)
    await ing.on_message("/scan", object(), 0)
    assert [e["t"] for e in drain(q)] == ["map"] and state.map.version == 1


def test_clock_skew_warns_once_per_30s(caplog):
    ing, *_ = make()
    old = datetime(2020, 1, 1, tzinfo=timezone.utc)
    with caplog.at_level(logging.WARNING):
        ing._check_clock(old); ing._check_clock(old); ing._check_clock(datetime.now(timezone.utc))
    assert caplog.text.count("clock skew") == 1
