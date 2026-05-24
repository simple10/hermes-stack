"""Exponential backoff with ±jitter. Shared by pull and push loops."""
from __future__ import annotations

import random


class Backoff:
    def __init__(
        self,
        base: float = 5.0,
        factor: float = 2.0,
        cap: float = 120.0,
        jitter: float = 0.25,
    ):
        self._base = base
        self._factor = factor
        self._cap = cap
        self._jitter = jitter
        self._n = 0

    def next(self) -> float:
        """Return the next delay (seconds) and advance the counter."""
        delay = min(self._cap, self._base * (self._factor ** self._n))
        self._n += 1
        delta = delay * self._jitter
        return max(0.1, delay + random.uniform(-delta, delta))

    def reset(self) -> None:
        self._n = 0
