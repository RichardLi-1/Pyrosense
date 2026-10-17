from app.alerts import AlertEngine


def test_requires_hold_time():
    e = AlertEngine(threshold=250, hold_seconds=5, cooldown_seconds=60)
    assert e.update(300, 0) is False
    assert e.update(300, 4.9) is False
    assert e.update(300, 5.0) is True


def test_dip_below_resets_hold():
    e = AlertEngine(250, 5, 60)
    e.update(300, 0); e.update(200, 3); e.update(300, 4)
    assert e.update(300, 8.9) is False
    assert e.update(300, 9.0) is True


def test_cooldown_blocks_refire():
    e = AlertEngine(250, 5, 60)
    e.update(300, 0)
    assert e.update(300, 5) is True
    assert e.update(300, 30) is False       # still above, within cooldown
    assert e.update(300, 64.9) is False
    assert e.update(300, 65) is True        # cooldown over and held 5 s since last fire


def test_exact_threshold_is_not_alert():
    e = AlertEngine(250, 0, 0)
    assert e.update(250, 0) is False
    assert e.update(250.1, 0) is True


def test_reset_clears_hold_and_cooldown():
    e = AlertEngine(250, 5, 60)
    e.update(300, 0); assert e.update(300, 5) is True
    e.reset()
    assert e.armed_since is None
    assert e.update(300, 6) is False and e.update(300, 11) is True   # fresh hold, no cooldown


def test_cooldown_needs_fresh_hold_after_dip():
    e = AlertEngine(250, 5, 60)
    e.update(300, 0); e.update(300, 5)
    e.update(100, 70)                       # dip after cooldown
    assert e.update(300, 71) is False and e.update(300, 76) is True
