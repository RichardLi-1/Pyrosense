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


def test_timed_out_of_order_points_preserve_message_order():
    tracker = PointTracker()
    tracker.new_points(pts((0, 0, 0, 10)), ts(10))
    new = tracker.new_points(
        pts((1, 0, 0, 13), (2, 0, 0, 9), (3, 0, 0, 11)), ts(13, 9, 11)
    )
    assert new.tolist() == [[1, 0, 0, 13], [3, 0, 0, 11]]
    assert tracker.last_t == 13
    assert len(tracker.new_points(pts((4, 0, 0, 12)), ts(12))) == 0
    assert tracker.last_t == 13


def test_empty_timed_message_does_not_forget_previous_readings():
    tracker = PointTracker()
    reading = pts((1, 2, 0, 42))
    tracker.new_points(reading, ts(5))
    assert tracker.new_points(pts(), ts()).shape == (0, 4)
    assert tracker.last_t == 5
    assert len(tracker.new_points(reading, ts(5))) == 0
    assert tracker.new_points(reading, ts(6)).tolist() == reading.tolist()


def test_tracker_reset_accepts_older_timestamps_and_legacy_points():
    tracker = PointTracker()
    reading = pts((1, 2, 0, 42))
    tracker.new_points(reading)
    tracker.new_points(reading, ts(100))
    tracker.reset()
    assert tracker.new_points(reading, ts(1)).tolist() == reading.tolist()
    assert tracker.new_points(reading).tolist() == reading.tolist()


def test_session_switch_clears_sensor_but_preserves_map_and_bridge():
    state = LiveState("old")
    grid = MapGrid(datetime(2026, 1, 1, tzinfo=timezone.utc), 1, 1, 1, 0, 0,
                   np.zeros((1, 1), dtype=np.int8))
    saved_map = state.set_map(grid, b"png")
    state.bridge_connected = True
    state.sensor = {"voc": 42, "warmed_up": True}
    state.push_voc(42, grid.ts)
    state.new_session("new")
    hello = state.hello_event(250)
    assert hello["session"] == "new"
    assert hello["sensor"] is None
    assert hello["voc_window"] == []
    assert state.voc_ts is None
    assert state.map is saved_map
    assert hello["bridge_connected"] is True


def test_voc_window_retains_exact_cutoff_and_expires_after_it(monkeypatch):
    state = LiveState("test", voc_window_seconds=60)
    clock = [1000.0]
    monkeypatch.setattr(time, "time", lambda: clock[0])
    stamp = datetime(2026, 1, 1, tzinfo=timezone.utc)
    state.push_voc(10, stamp)
    clock[0] = 1060.0
    state.push_voc(20, stamp)
    assert list(state.voc_window) == [(1000.0, 10), (1060.0, 20)]
    clock[0] = 1060.001
    state.push_voc(30, stamp)
    assert [value for _, value in state.voc_window] == [20, 30]
    assert state.voc == 30 and state.voc_ts == stamp


def test_slow_subscriber_does_not_drop_fast_subscriber_events():
    async def run():
        bus = Broadcaster(maxsize=2)
        slow, fast = bus.subscribe(), bus.subscribe()
        for i in range(5):
            bus.publish({"i": i})
            assert fast.get_nowait() == {"i": i}
        assert [slow.get_nowait(), slow.get_nowait()] == [{"i": 3}, {"i": 4}]
        assert fast.empty()
    asyncio.run(run())
