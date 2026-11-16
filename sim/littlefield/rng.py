"""Seeded random numbers that a JavaScript port can reproduce exactly.

mulberry32 uses only 32-bit integer arithmetic, so Python and JavaScript
give the same stream for the same seed (tests/test_rng.py pins the first values).
"""
import math

_M = 0xFFFFFFFF


def _imul(a, b):
    return (a * b) & _M


class Rng:
    def __init__(self, seed):
        self.a = seed & _M

    def random(self):
        """Uniform in [0, 1)."""
        self.a = (self.a + 0x6D2B79F5) & _M
        t = self.a
        t = _imul(t ^ (t >> 15), t | 1)
        t ^= (t + _imul(t ^ (t >> 7), t | 61)) & _M
        return ((t ^ (t >> 14)) & _M) / 4294967296.0

    def exponential(self, rate):
        return -math.log(1.0 - self.random()) / rate

    def process(self, base, cv):
        """A process time with mean `base` and coefficient of variation `cv` (0 to 1).

        A constant part plus an exponential part: cv = 0 is constant, cv = 1 is exponential.
        """
        if cv <= 0:
            return base
        return base * ((1.0 - cv) + cv * self.exponential(1.0))
