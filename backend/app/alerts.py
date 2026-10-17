"""Exposure alert rule: live VOC above threshold for `hold` seconds, with cooldown."""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class AlertEngine:
    threshold: float
    hold_seconds: float
    cooldown_seconds: float
    _above_since: float | None = field(default=None, init=False)
    _last_fired: float | None = field(default=None, init=False)

    def reset(self) -> None:
        self._above_since = None
        self._last_fired = None

    @property
    def armed_since(self) -> float | None:
        return self._above_since

    def update(self, voc: float, now: float) -> bool:
        """Feed one live reading. Returns True exactly when an alert should fire."""
        if voc <= self.threshold:
            self._above_since = None
            return False
        if self._above_since is None:
            self._above_since = now
        if now - self._above_since < self.hold_seconds:
            return False
        if self._last_fired is not None and now - self._last_fired < self.cooldown_seconds:
            return False
        self._last_fired = now
        self._above_since = now  # require another full hold before the next one
        return True
