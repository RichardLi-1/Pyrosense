import asyncio

import numpy as np

from app.state import Broadcaster, PointTracker


def pts(*rows):
    return np.array(rows, dtype=np.float32)


def test_tracker_full_list_growth():
    t = PointTracker()
    a = pts((0, 0, 0, 10), (1, 0, 0, 11))
    assert len(t.new_points(a)) == 2
    assert len(t.new_points(a)) == 0
    b = pts((0, 0, 0, 10), (1, 0, 0, 11), (2, 0, 0, 12))
    new = t.new_points(b)
    assert new.tolist() == [[2, 0, 0, 12]]


def test_tracker_reset_on_shrink():
    t = PointTracker()
    t.new_points(pts((0, 0, 0, 1), (1, 1, 1, 2), (2, 2, 2, 3)))
    assert len(t.new_points(pts((5, 5, 5, 9)))) == 1


def test_tracker_ring_buffer_same_length():
    t = PointTracker()
    t.new_points(pts((0, 0, 0, 1), (1, 1, 1, 2), (2, 2, 2, 3)))
    new = t.new_points(pts((1, 1, 1, 2), (2, 2, 2, 3), (3, 3, 3, 4)))
    assert new.tolist() == [[3, 3, 3, 4]]


def test_tracker_delta_only_publisher():
    """If the Pi ever publishes only the newest point each time, width stays 1 but content changes."""
    t = PointTracker()
    assert len(t.new_points(pts((0, 0, 0, 1)))) == 1
    assert len(t.new_points(pts((0.5, 0, 0, 2)))) == 1
    assert len(t.new_points(pts((0.5, 0, 0, 2)))) == 0


def test_broadcaster_drops_oldest_when_full():
    async def run():
        b = Broadcaster(maxsize=2)
        q = b.subscribe()
        for i in range(3):
            b.publish({"i": i})
        assert q.qsize() == 2 and q.get_nowait() == {"i": 1}
    asyncio.run(run())
