"""Confirm a blade pass from within-window RSSI variation before handoff."""
from __future__ import annotations

import math
from collections import deque
from statistics import median


def percentile(sorted_values, fraction):
    position = (len(sorted_values) - 1) * fraction
    lower = int(position)
    upper = min(lower + 1, len(sorted_values) - 1)
    return sorted_values[lower] + (sorted_values[upper] - sorted_values[lower]) * (position - lower)


class RssiHandoff:
    def __init__(self, config, travel_seconds: float, *, require_background=False):
        self.config = config
        # Movement duration is metadata only; it must never cause early motion.
        self.rate = self.expected = self.origin = None
        self.stride = None
        self.values = []
        self.armed = False
        self.entry_ms = self.exit_ms = 0.0
        self.entry_start = self.entry_confirmed = self.exit_start = None
        self.trigger = None
        self.events = []
        # Automatic point changes can finish in the middle of a blade pass.
        # Establish a local, stable echo baseline before accepting a new entry;
        # a low-variation patch alone is not proof of a physical background.
        self.require_background = require_background
        self.background_ready = not require_background
        self.background_ms = 0.0
        self.background_values = deque()
        self.background_sample = None
        self.entry_baseline = None
        self.entry_baseline_tolerance = None
        self.partial_seen = False
        self.unmatched_exit_ms = 0.0
        self.status = {"rssiPhase": "waiting_background" if require_background else "waiting_blade", "latestRssi": None, "rssiSamples": 0,
                       "rssiSpread": None, "rssiEntryMs": 0, "rssiBelowMs": 0,
                       "rssiTrigger": None, "rssiEnterSpread": config.rssiEnterSpread,
                       "rssiExitSpread": config.rssiExitSpread,
                       "rssiEnterConfirmMs": config.rssiEnterConfirmMs,
                       "rssiConfirmMs": config.rssiConfirmMs,
                       "signalGapCount": 0, "lastSignalGapReason": None,
                       "rssiRequireBackground": require_background,
                       "rssiBackgroundRequiredMs": max(50, config.rssiConfirmMs),
                       "rssiBackgroundMs": 0, "rssiBackgroundReady": self.background_ready,
                       "rssiBackgroundMean": None, "rssiPartialPassesIgnored": 0,
                       "rssiBaselineMismatches": 0}

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

    def _gap(self, reason="invalid_rssi"):
        self.values.clear()
        self.entry_ms = self.exit_ms = 0.0
        self.armed = False
        self.entry_start = self.entry_confirmed = self.exit_start = None
        self.background_ready = not self.require_background
        self.background_values.clear()
        self.background_ms = 0.0
        self.background_sample = self.entry_baseline = self.entry_baseline_tolerance = None
        self.partial_seen = False
        self.unmatched_exit_ms = 0.0
        self.status.update(rssiSpread=None, rssiEntryMs=0, rssiBelowMs=0,
                           rssiBackgroundMs=0, rssiBackgroundReady=self.background_ready,
                           rssiBackgroundMean=None,
                           signalGapCount=self.status["signalGapCount"] + 1,
                           lastSignalGapReason=reason)
        self.events.append({"phase": "signal_reset", "reason": reason})
        self._phase("waiting_background" if self.require_background else "waiting_blade")

    def feed(self, batch):
        if self.trigger is not None:
            return self.status
        rate = batch.sample_rate
        stride = batch.rssi_sample_stride
        if (not math.isfinite(rate) or rate <= 0 or isinstance(stride, bool) or
                not isinstance(stride, int) or not 1 <= stride <= 100_000 or batch.sample_start % stride):
            self._gap("invalid_sample_timing")
            return self.status
        if ((self.rate is not None and self.rate != rate) or
                (self.stride is not None and self.stride != stride) or
                (self.expected is not None and batch.sample_start != self.expected)):
            self._gap("noncontiguous_samples_or_changed_rate")
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
            self._gap("missing_rssi_samples")
        return self.status

    def _window(self, mean, spread, sample_end, seconds):
        elapsed = (sample_end - self.origin) / self.rate
        self.status.update(latestRssi=mean, rssiSpread=spread)
        if elapsed < self.config.rssiMinimumSeconds:
            self.entry_ms = self.exit_ms = 0.0
            self.status.update(rssiEntryMs=0, rssiBelowMs=0)
            return
        if self.require_background and not self.armed:
            if spread <= self.config.rssiExitSpread:
                self.background_values.append((mean, seconds * 1000))
                # A moving mean must not qualify as a stable pre-entry baseline.
                tolerance = max(2 * self.config.rssiExitSpread, self.config.rssiEnterSpread * .75)
                while (self.background_values and
                       max(v[0] for v in self.background_values) - min(v[0] for v in self.background_values) > tolerance):
                    self.background_values.popleft()
                self.background_ms = sum(v[1] for v in self.background_values)
                required = self.status["rssiBackgroundRequiredMs"]
                while len(self.background_values) > 1 and self.background_ms - self.background_values[0][1] >= required:
                    self.background_ms -= self.background_values.popleft()[1]
                self.status.update(rssiBackgroundMs=self.background_ms,
                                   rssiBackgroundMean=median(v[0] for v in self.background_values))
                if not self.background_ready and self.background_ms + 1e-6 >= required:
                    self.background_ready = True
                    self.background_sample = sample_end - 1
                    self.status["rssiBackgroundReady"] = True
                    self._phase("background_ready", sample_end)
                    self._phase("waiting_blade", sample_end)
            elif not self.background_ready:
                self.background_values.clear()
                self.background_ms = 0.0
                self.status.update(rssiBackgroundMs=0, rssiBackgroundMean=None)
                if spread >= self.config.rssiEnterSpread and not self.partial_seen:
                    self.partial_seen = True
                    self.status["rssiPartialPassesIgnored"] += 1
                    self._phase("partial_pass_ignored", sample_end)
                else:
                    self._phase("waiting_background", sample_end)
            if not self.background_ready:
                return
        if not self.armed:
            if spread >= self.config.rssiEnterSpread and self.entry_ms == 0:
                self.entry_start = max(self.origin, sample_end - round(seconds * self.rate))
                if self.require_background:
                    self.entry_baseline = self.status["rssiBackgroundMean"]
                    self.entry_baseline_tolerance = max(2 * self.config.rssiExitSpread,
                                                         self.config.rssiEnterSpread * .75)
            self.entry_ms = self.entry_ms + seconds * 1000 if spread >= self.config.rssiEnterSpread else 0.0
            if self.entry_ms == 0:
                self.entry_start = None
            self.status["rssiEntryMs"] = self.entry_ms
            self._phase("confirming_entry" if self.entry_ms else "waiting_blade", sample_end)
            if self.entry_ms + 1e-6 >= self.config.rssiEnterConfirmMs:
                self.armed = True
                self.entry_confirmed = sample_end - 1
                self._phase("blade_present", sample_end)
            return
        # Only a continuous low-variation interval confirms exit after entry.
        returned_to_baseline = (not self.require_background or
                                abs(mean - self.entry_baseline) <= self.entry_baseline_tolerance)
        exit_window = spread <= self.config.rssiExitSpread and returned_to_baseline
        self.unmatched_exit_ms = (self.unmatched_exit_ms + seconds * 1000
                                  if self.require_background and spread <= self.config.rssiExitSpread
                                  and not returned_to_baseline else 0.0)
        if self.unmatched_exit_ms + 1e-6 >= max(100, 3 * self.config.rssiConfirmMs):
            # Echo backgrounds can drift. Do not remain armed indefinitely, or
            # call a stable patch on the blade a complete exit. Discard this
            # ambiguous candidate and require another baseline + entry.
            self.armed = self.background_ready = False
            self.entry_ms = self.exit_ms = self.background_ms = self.unmatched_exit_ms = 0.0
            self.entry_start = self.entry_confirmed = self.exit_start = None
            self.background_sample = self.entry_baseline = self.entry_baseline_tolerance = None
            self.background_values.clear()
            self.partial_seen = False
            self.status.update(rssiBackgroundMs=0, rssiBackgroundReady=False, rssiBackgroundMean=None,
                               rssiEntryMs=0, rssiBelowMs=0,
                               rssiBaselineMismatches=self.status["rssiBaselineMismatches"] + 1)
            self._phase("pass_baseline_mismatch", sample_end)
            self._phase("waiting_background", sample_end)
            return
        if exit_window and self.exit_ms == 0:
            self.exit_start = max(self.origin, sample_end - round(seconds * self.rate))
        self.exit_ms = self.exit_ms + seconds * 1000 if exit_window else 0.0
        if self.exit_ms == 0:
            self.exit_start = None
        self.status["rssiBelowMs"] = self.exit_ms
        self._phase("confirming_exit" if self.exit_ms else "blade_present", sample_end)
        if self.exit_ms + 1e-6 >= self.config.rssiConfirmMs:
            self.trigger = {"reason": "blade_left", "sampleIndex": sample_end - 1,
                            "sampleElapsedSeconds": elapsed, "rssi": mean,
                            "rssiSpread": spread, "enterSpread": self.config.rssiEnterSpread,
                            "exitSpread": self.config.rssiExitSpread,
                            "enterConfirmedMs": self.entry_ms, "confirmedMs": self.exit_ms,
                            "entrySampleIndex": self.entry_start,
                            "entryConfirmedSampleIndex": self.entry_confirmed,
                            "exitSampleIndex": self.exit_start,
                            "exitConfirmedSampleIndex": sample_end - 1,
                            "observedSamples": sample_end - self.entry_start,
                            "detectorVersion": 2 if self.require_background else 1,
                            "requireBackground": self.require_background,
                            "backgroundConfirmedSampleIndex": self.background_sample,
                            "backgroundRequiredMs": self.status["rssiBackgroundRequiredMs"],
                            "baselineRssi": self.entry_baseline,
                            "baselineTolerancePp": self.entry_baseline_tolerance,
                            "partialPassesIgnored": self.status["rssiPartialPassesIgnored"],
                            "baselineMismatches": self.status["rssiBaselineMismatches"]}
            self.status["rssiTrigger"] = "blade_left"
            self._phase("blade_left", sample_end)
