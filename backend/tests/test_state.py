import asyncio
import time
from datetime import datetime, timezone

import numpy as np

from app.ros import MapGrid, Pose
from app.state import Broadcaster, LiveState, PointTracker


def pts(*rows):
    return np.array(rows, dtype=np.float32).reshape(-1, 4)


def ts(*v):
    return np.array(v, dtype=np.float64)


# ---- PointTracker with per-point t (the reliable path) ---------------------------

def test_timed_full_list_growth():
    t = PointTracker()
    assert len(t.new_points(pts((0, 0, 0, 10), (1, 0, 0, 11)), ts(1, 2))) == 2
    assert len(t.new_points(pts((0, 0, 0, 10), (1, 0, 0, 11)), ts(1, 2))) == 0
    new = t.new_points(pts((0, 0, 0, 10), (1, 0, 0, 11), (2, 0, 0, 12)), ts(1, 2, 3))
    assert new.tolist() == [[2, 0, 0, 12]]


def test_timed_standing_still_keeps_identical_readings():
    t = PointTracker()
    assert len(t.new_points(pts((1, 2, 0, 183)), ts(10))) == 1
    assert len(t.new_points(pts((1, 2, 0, 183)), ts(11))) == 1   # same spot, same index, new reading
    assert len(t.new_points(pts((1, 2, 0, 183)), ts(11))) == 0   # true re-publish


def test_timed_ring_buffer_repeat_value_is_new():
    t = PointTracker()
    t.new_points(pts((1, 2, 0, 183), (3, 3, 0, 90), (4, 4, 0, 95)), ts(1, 2, 3))
    new = t.new_points(pts((3, 3, 0, 90), (4, 4, 0, 95), (1, 2, 0, 183)), ts(2, 3, 4))
    assert new.tolist() == [[1, 2, 0, 183]]


def test_timed_publisher_restart_with_shorter_list():
    t = PointTracker()
    t.new_points(pts(*[(i, 0, 0, i) for i in range(5)]), ts(1, 2, 3, 4, 5))
    assert len(t.new_points(pts((9, 9, 0, 9)), ts(100))) == 1


def test_new_index_points_into_message():
    t = PointTracker()
    t.new_index(pts((0, 0, 0, 1)), ts(1))
    assert t.new_index(pts((0, 0, 0, 1), (1, 1, 0, 2), (2, 2, 0, 3)), ts(1, 2, 3)).tolist() == [1, 2]
    assert t.new_index(pts()).tolist() == []


# ---- PointTracker without t (legacy guessing) -------------------------------------

def test_untimed_full_list_growth():
    t = PointTracker()
    a = pts((0, 0, 0, 10), (1, 0, 0, 11))
    assert len(t.new_points(a)) == 2
    assert len(t.new_points(a)) == 0
    assert t.new_points(pts((0, 0, 0, 10), (1, 0, 0, 11), (2, 0, 0, 12))).tolist() == [[2, 0, 0, 12]]


def test_untimed_reset_on_shrink():
    t = PointTracker()
    t.new_points(pts((0, 0, 0, 1), (1, 1, 1, 2), (2, 2, 2, 3)))
    assert len(t.new_points(pts((5, 5, 5, 9)))) == 1


def test_untimed_ring_buffer_same_length():
    t = PointTracker()
    t.new_points(pts((0, 0, 0, 1), (1, 1, 1, 2), (2, 2, 2, 3)))
    assert t.new_points(pts((1, 1, 1, 2), (2, 2, 2, 3), (3, 3, 3, 4))).tolist() == [[3, 3, 3, 4]]


def test_untimed_delta_publisher_known_limitation():
    """Without t, an identical consecutive reading is indistinguishable from a re-publish."""
    t = PointTracker()
    assert len(t.new_points(pts((0, 0, 0, 1)))) == 1
    assert len(t.new_points(pts((0.5, 0, 0, 2)))) == 1
    assert len(t.new_points(pts((0.5, 0, 0, 2)))) == 0


def test_untimed_seen_trim_keeps_newest(monkeypatch):
    monkeypatch.setattr(PointTracker, "SEEN_MAX", 10)
    t = PointTracker()
    for i in range(11):  # delta publisher: one new point per message
        t.new_points(pts((i, 0, 0, i)))
    assert len(t._seen) == 5
    assert set(t._seen) == {(float(i), 0.0, 0.0, float(i)) for i in range(6, 11)}


# ---- LiveState --------------------------------------------------------------------

def test_new_session_clears_live_but_keeps_tracker():
    s = LiveState("a")
    s.tracker.new_points(pts((0, 0, 0, 1)), ts(1))
    s.pose = Pose(datetime.now(timezone.utc), 1, 2, 0)
    s.push_voc(100, datetime.now(timezone.utc)); s.n_samples = 3
    s.new_session("b")
    assert (s.session, s.pose, s.voc, s.n_samples, len(s.voc_window)) == ("b", None, None, 0, 0)
    assert s.tracker.last_t == 1


def test_voc_window_drops_old(monkeypatch):
    s = LiveState("a", voc_window_seconds=60)
    clock = [1000.0]
    monkeypatch.setattr(time, "time", lambda: clock[0])
    s.push_voc(1, datetime.now(timezone.utc))
    clock[0] = 1059.0; s.push_voc(2, datetime.now(timezone.utc))
    clock[0] = 1061.0; s.push_voc(3, datetime.now(timezone.utc))
    assert [v for _, v in s.voc_window] == [2, 3] and s.voc == 3


def test_events():
    s = LiveState("a")
    assert s.pose_event() is None
    s.pose = Pose(datetime(2026, 1, 1, tzinfo=timezone.utc), 1.0, 2.0, 0.5); s.voc = 42
    assert s.pose_event() == {"t": "pose", "ts": "2026-01-01T00:00:00+00:00", "x": 1.0, "y": 2.0,
                              "heading": 0.5, "voc": 42}
    h = s.hello_event(250)
    assert h["t"] == "hello" and h["threshold"] == 250 and h["voc_window"] == [] and h["bridge_connected"] is False
    g = MapGrid(datetime(2026, 1, 1, tzinfo=timezone.utc), 2, 1, 0.05, -1, -2, np.array([[0, 100]], np.int8))
    assert s.set_map(g, b"png").version == 1 and s.set_map(g, b"png").version == 2
    ev = s.map.event()
    assert ev["url"] == "/map?v=2" and ev["origin"] == [-1, -2] and ev["free_area_m2"] == 0.0


# ---- Broadcaster ------------------------------------------------------------------

def test_broadcaster_drops_oldest_when_full():
    async def run():
        b = Broadcaster(maxsize=2)
        q = b.subscribe()
        for i in range(3):
            b.publish({"i": i})
        assert q.qsize() == 2 and q.get_nowait() == {"i": 1}
    asyncio.run(run())


def test_broadcaster_fans_out_and_unsubscribes():
    async def run():
        b = Broadcaster()
        q1, q2 = b.subscribe(), b.subscribe()
        b.publish({"n": 1})
        assert q1.get_nowait() == q2.get_nowait() == {"n": 1} and b.n_clients == 2
        b.unsubscribe(q1); b.unsubscribe(q1)
        b.publish({"n": 2})
        assert q1.empty() and q2.get_nowait() == {"n": 2} and b.n_clients == 1
    asyncio.run(run())
