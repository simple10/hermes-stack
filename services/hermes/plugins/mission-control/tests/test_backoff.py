from mission_control.backoff import Backoff


def test_first_delay_is_near_base():
    b = Backoff(base=5.0, factor=2.0, cap=120.0, jitter=0.0)
    assert b.next() == 5.0


def test_exponential_progression():
    b = Backoff(base=5.0, factor=2.0, cap=120.0, jitter=0.0)
    assert b.next() == 5.0
    assert b.next() == 10.0
    assert b.next() == 20.0
    assert b.next() == 40.0
    assert b.next() == 80.0
    assert b.next() == 120.0  # cap
    assert b.next() == 120.0  # held at cap


def test_reset_returns_to_base():
    b = Backoff(base=5.0, factor=2.0, cap=120.0, jitter=0.0)
    b.next(); b.next(); b.next()
    b.reset()
    assert b.next() == 5.0


def test_jitter_within_bounds():
    b = Backoff(base=10.0, factor=1.0, cap=100.0, jitter=0.25)
    for _ in range(50):
        # value should be in [7.5, 12.5]
        v = b.next()
        b.reset()
        assert 7.5 <= v <= 12.5


def test_min_delay_floor():
    """Even at small base + negative jitter, delay never goes below 0.1."""
    b = Backoff(base=0.05, factor=1.0, cap=1.0, jitter=0.9)
    for _ in range(20):
        v = b.next()
        b.reset()
        assert v >= 0.1
