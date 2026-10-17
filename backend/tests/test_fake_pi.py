import random

from tools.fake_pi import ORIGIN, RES, ROOM_H, ROOM_W, Walker, voc_at


def test_walker_stays_in_room_and_maps_walls():
    random.seed(0)
    w = Walker()
    for _ in range(600):
        w.step(0.1)
        assert 0.5 < w.x < ROOM_W - 0.5 and 0.5 < w.y < ROOM_H - 0.5
    g = w.grid
    assert (g == 0).sum() > 0 and (g == 100).sum() > 0
    col = int((ROOM_W / 2 - ORIGIN[0]) / RES); row = int((0 - ORIGIN[1]) / RES)
    assert 100 in g[row - 1:row + 2, col]                         # south wall at y = 0


def test_voc_source_and_spike():
    random.seed(0)
    near, far = voc_at(ROOM_W - 1.5, 1.5, 0, None), voc_at(1, ROOM_H - 1, 0, None)
    assert near > 300 > 100 > far
    assert voc_at(1, ROOM_H - 1, 21, spike_at=20) > far + 300
    assert voc_at(1, ROOM_H - 1, 19, spike_at=20) < 120
