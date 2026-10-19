"""Confirm a blade pass from within-window RSSI variation before handoff."""
from __future__ import annotations

import math


def percentile(sorted_values, fraction):
    position = (len(sorted_values) - 1) * fraction
    lower = int(position)
    upper = min(lower + 1, len(sorted_values) - 1)
    return sorted_values[lower] + (sorted_values[upper] - sorted_values[lower]) * (position - lower)


class RssiHandoff:
    def __init__(self, config, travel_seconds: float):
        self.config = config
        # Movement duration is metadata only; it must never cause early motion.
        self.rate = self.expected = self.origin = None
        self.stride = None
        self.values = []
        self.armed = False
        self.entry_ms = self.exit_ms = 0.0
        self.trigger = None
        self.events = []
        self.status = {"rssiPhase": "waiting_blade", "latestRssi": None, "rssiSamples": 0,
                       "rssiSpread": None, "rssiEntryMs": 0, "rssiBelowMs": 0,
                       "rssiTrigger": None, "rssiEnterSpread": config.rssiEnterSpread,
                       "rssiExitSpread": config.rssiExitSpread,
                       "rssiEnterConfirmMs": config.rssiEnterConfirmMs,
                       "rssiConfirmMs": config.rssiConfirmMs}

    def drain_events(self):
        result, self.events = self.events, []
        return result

    def _phase(self, phase, sample_end=None):
        if self.status["rssiPhase"] == phase:
            return
        self.status["rssiPhase"] = phase
        self.events.append({"phase": phase,
                            "sampleIndex": sample_end - 1 if sample_end is not None else None,
                            "sampleElapsedSeconds": ((sample_end - self.origin) / self.rate
                                                     if sample_end is not None else None),
                            "rssiSpread": self.status["rssiSpread"]})

    def _gap(self):
        self.values.clear()
        self.entry_ms = self.exit_ms = 0.0
        self.armed = False
        self.status.update(rssiSpread=None, rssiEntryMs=0, rssiBelowMs=0)
        self.events.append({"phase": "signal_reset"})
        self._phase("waiting_blade")

    def feed(self, batch):
        if self.trigger is not None:
            return self.status
        rate = batch.sample_rate
        stride = batch.rssi_sample_stride
        if (not math.isfinite(rate) or rate <= 0 or isinstance(stride, bool) or
                not isinstance(stride, int) or not 1 <= stride <= 100_000 or batch.sample_start % stride):
            self._gap()
            return self.status
        if ((self.rate is not None and self.rate != rate) or
                (self.stride is not None and self.stride != stride) or
                (self.expected is not None and batch.sample_start != self.expected)):
            self._gap()
            self.origin = None
        self.rate = rate
        self.stride = stride
        if self.origin is None:
            self.origin = batch.sample_start
        self.expected = batch.sample_start + len(batch.values)
        rssi_rate = rate / stride
        window = max(1, math.ceil(rssi_rate * self.config.rssiSmoothingMs / 1000))
        expected_rssi = (len(batch.values) + stride - 1) // stride
        length = min(len(batch.rssi), expected_rssi)
        offset = 0
        while offset < length:
            end = min(length, offset + window - len(self.values))
            values = batch.rssi[offset:end]
            if any(not isinstance(value, (int, float)) or isinstance(value, bool) or
                   not math.isfinite(value) or not 0 <= value <= 100 for value in values):
                self._gap()
                offset = end
                continue
            self.values.extend(values)
            self.status["rssiSamples"] += len(values)
            offset = end
            if len(self.values) == window:
                ordered = sorted(self.values)
                mean = math.fsum(self.values) / window
                spread = percentile(ordered, .9) - percentile(ordered, .1)
                self.values.clear()
                self._window(mean, spread, batch.sample_start + min(end * stride, len(batch.values)), window / rssi_rate)
                if self.trigger is not None:
                    break
        if length < expected_rssi and self.trigger is None:
            self._gap()
        return self.status

    def _window(self, mean, spread, sample_end, seconds):
        elapsed = (sample_end - self.origin) / self.rate
        self.status.update(latestRssi=mean, rssiSpread=spread)
        if elapsed < self.config.rssiMinimumSeconds:
            self.entry_ms = self.exit_ms = 0.0
            self.status.update(rssiEntryMs=0, rssiBelowMs=0)
            return
        if not self.armed:
            self.entry_ms = self.entry_ms + seconds * 1000 if spread >= self.config.rssiEnterSpread else 0.0
            self.status["rssiEntryMs"] = self.entry_ms
            self._phase("confirming_entry" if self.entry_ms else "waiting_blade", sample_end)
            if self.entry_ms + 1e-6 >= self.config.rssiEnterConfirmMs:
                self.armed = True
                self._phase("blade_present", sample_end)
            return
        # Only a continuous low-variation interval confirms exit after entry.
        self.exit_ms = self.exit_ms + seconds * 1000 if spread <= self.config.rssiExitSpread else 0.0
        self.status["rssiBelowMs"] = self.exit_ms
        self._phase("confirming_exit" if self.exit_ms else "blade_present", sample_end)
        if self.exit_ms + 1e-6 >= self.config.rssiConfirmMs:
            self.trigger = {"reason": "blade_left", "sampleIndex": sample_end - 1,
                            "sampleElapsedSeconds": elapsed, "rssi": mean,
                            "rssiSpread": spread, "enterSpread": self.config.rssiEnterSpread,
                            "exitSpread": self.config.rssiExitSpread,
                            "enterConfirmedMs": self.entry_ms, "confirmedMs": self.exit_ms}
            self.status["rssiTrigger"] = "blade_left"
            self._phase("blade_left", sample_end)
