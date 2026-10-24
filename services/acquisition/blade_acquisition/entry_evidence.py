"""Entry features; the caller decides whether a candidate needs corroboration.

RSSI mean contrast OR a velocity RMS increase can support an entry candidate.
These are signal features, not independent proof that a particular blade passed.
No extra time window or sleep is introduced. Arrival-guard mode uses the
velocity feature for narrowly scoped disturbed-arrival candidates; the legacy
OR feature remains diagnostic and is not proof of a physical blade pass.
"""
from collections import deque


class EntryEvidence:
    def __init__(self, enter_spread, exit_spread):
        self.enter_spread = enter_spread
        self.exit_spread = exit_spread
        self.quiet = deque(maxlen=10)
        self.baseline = self.noise = None
        self.contrast = self.peak = 0.0
        self.velocity_valid = True

    def window(self, mean, spread, rms, *, entry_starting, armed):
        if armed:
            return
        if entry_starting:
            self.contrast = self.peak = 0.0
            self.velocity_valid = True
            self.baseline = self.quiet[-1][0] if self.quiet else None
            noise = sorted(v for _, v in self.quiet if v is not None)
            if noise and len(noise) == len(self.quiet):
                p = (len(noise) - 1) * .9
                lo = int(p)
                self.noise = noise[lo] + (noise[min(lo + 1, len(noise) - 1)] - noise[lo]) * (p - lo)
            else:
                self.noise = None
        if spread <= self.exit_spread:
            self.quiet.append((mean, rms))
        if spread >= self.enter_spread:
            if self.baseline is not None:
                self.contrast = max(self.contrast, abs(mean - self.baseline))
            if rms is None:
                self.velocity_valid = False
            else:
                self.peak = max(self.peak, rms)

    def result(self):
        echo = self.baseline is not None and self.contrast >= self.enter_spread
        velocity = (self.velocity_valid and self.noise is not None and
                    self.peak >= max(1e-6, 3 * self.noise))
        return {"algorithmVersion": 1, "supported": bool(echo or velocity),
                "echoContrastPp": self.contrast, "echoContrastLimitPp": self.enter_spread,
                "velocityPeakMps": self.peak if self.velocity_valid else None,
                "quietVelocityP90Mps": self.noise, "velocityRatioLimit": 3,
                "echoSupported": echo, "velocitySupported": bool(velocity)}
