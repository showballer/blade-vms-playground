"""Confirm a blade pass from within-window RSSI variation before handoff."""
from __future__ import annotations

import math
from collections import deque
from statistics import median
from .entry_evidence import EntryEvidence


def percentile(sorted_values, fraction):
    position = (len(sorted_values) - 1) * fraction
    lower = int(position)
    upper = min(lower + 1, len(sorted_values) - 1)
    return sorted_values[lower] + (sorted_values[upper] - sorted_values[lower]) * (position - lower)


class RssiHandoff:
    def __init__(self, config, travel_seconds: float, *, require_background=False, background_advisory=False, require_fresh_entry=False, require_stable_entry_mean=False, entry_evidence_mode="off", revalidate_entry_clear=False):
        if entry_evidence_mode not in ("off", "observe", "required", "arrival_guard"):
            raise ValueError("Unknown entry evidence mode")
        if entry_evidence_mode == "required" and not require_fresh_entry:
            raise ValueError("Experimental entry evidence requires fresh entry qualification")
        if entry_evidence_mode == "arrival_guard" and not (require_fresh_entry and require_stable_entry_mean and revalidate_entry_clear):
            raise ValueError("Arrival evidence guard requires fresh, revalidated stable entry")
        self.config = config
        self.entry_evidence_mode = entry_evidence_mode
        self.evidence = EntryEvidence(config.rssiEnterSpread, config.rssiExitSpread)
        self.velocity_energy = self.velocity_count = 0
        self.velocity_valid = True
        self.accepted_evidence = None
        self.arrival_disturbance_seen = False
        # Movement duration is metadata only; it must never cause early motion.
        self.rate = self.expected = self.origin = None
        self.stride = None
        self.values = []
        self.armed = False
        self.entry_ms = self.exit_ms = self.baseline_exit_ms = 0.0
        self.entry_start = self.entry_confirmed = self.exit_start = None
        self.trigger = None
        self.events = []
        # Automatic point changes can finish in the middle of a blade pass.
        # Strict mode gates entry on a baseline. Advisory mode only records
        # baseline evidence for quality; it never delays a confirmed handoff.
        self.background_advisory = background_advisory
        self.observe_background = require_background or background_advisory
        self.require_background = require_background
        self.require_fresh_entry = require_fresh_entry
        self.require_stable_entry_mean = require_fresh_entry and require_stable_entry_mean
        self.revalidate_entry_clear = bool(revalidate_entry_clear and self.require_stable_entry_mean)
        self.entry_clear_values = deque()
        self.entry_clear_sample = None
        self.entry_edge_ready = not require_fresh_entry
        self.entry_clear_ms = 0.0
        self.background_ready = not self.observe_background
        self.background_ms = 0.0
        self.background_values = deque()
        self.background_sample = None
        self.entry_baseline = None
        self.entry_baseline_tolerance = None
        self.partial_seen = False
        self.unmatched_exit_ms = 0.0
        self.status = {"rssiPhase": "waiting_entry_clear" if require_fresh_entry else "waiting_background" if require_background else "waiting_blade", "latestRssi": None, "rssiSamples": 0,
                       "rssiSpread": None, "rssiEntryMs": 0, "rssiBelowMs": 0,
                       "rssiTrigger": None, "rssiEnterSpread": config.rssiEnterSpread,
                       "rssiExitSpread": config.rssiExitSpread,
                       "rssiEnterConfirmMs": config.rssiEnterConfirmMs,
                       "rssiConfirmMs": config.rssiConfirmMs,
                       "signalGapCount": 0, "lastSignalGapReason": None,
                       "rssiRequireBackground": require_background,
                       "rssiFreshEntryRequired": require_fresh_entry,
                       "rssiEntryMeanGuard": self.require_stable_entry_mean,
                       "rssiEntryMeanRange": None, "rssiEntryMeanLimit": config.rssiExitSpread,
                       "rssiEntryDriftResets": 0,
                       "rssiEntryClearRevalidation": self.revalidate_entry_clear,
                       "rssiEntryClearRevocations": 0,
                       "rssiEntryEvidenceMode": entry_evidence_mode,
                       "rssiEntryEvidence": None, "rssiUnsupportedEntries": 0,
                       "rssiArrivalEvidenceRejections": 0,
                       "rssiEntryClearMs": 0, "rssiEntryEdgeReady": self.entry_edge_ready,
                       "rssiBackgroundPolicy": "advisory" if background_advisory else "required" if require_background else "disabled",
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
        self.evidence = EntryEvidence(self.config.rssiEnterSpread, self.config.rssiExitSpread)
        self.velocity_energy = self.velocity_count = 0
        self.velocity_valid = True
        self.accepted_evidence = None
        self.arrival_disturbance_seen = True
        self.status["rssiEntryEvidence"] = None
        self.entry_edge_ready = not self.require_fresh_entry
        self.entry_clear_ms = 0.0
        self.entry_clear_values.clear()
        self.entry_clear_sample = None
        self.status.update(rssiEntryMeanRange=None)
        self.status.update(rssiEntryClearMs=0, rssiEntryEdgeReady=self.entry_edge_ready)
        self.entry_ms = self.exit_ms = self.baseline_exit_ms = 0.0
        self.armed = False
        self.entry_start = self.entry_confirmed = self.exit_start = None
        self.background_ready = not self.observe_background
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
        self._phase("waiting_entry_clear" if self.require_fresh_entry else "waiting_background" if self.require_background else "waiting_blade")

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
            if self.entry_evidence_mode != "off":
                velocity = batch.values[offset * stride:min(end * stride, len(batch.values))]
                valid = all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
                            and abs(v) < 1e100 for v in velocity)
                overrange = getattr(batch, "overrange", None)
                if overrange is not None:
                    flags = overrange[offset * stride:min(end * stride, len(batch.values))]
                    valid = valid and len(flags) == len(velocity) and not any(flags)
                self.velocity_valid = self.velocity_valid and valid
                if valid:
                    self.velocity_energy += math.fsum(v * v for v in velocity)
                    self.velocity_count += len(velocity)
            self.status["rssiSamples"] += len(values)
            offset = end
            if len(self.values) == window:
                ordered = sorted(self.values)
                mean = math.fsum(self.values) / window
                spread = percentile(ordered, .9) - percentile(ordered, .1)
                self.values.clear()
                rms = (math.sqrt(self.velocity_energy / self.velocity_count)
                       if self.velocity_valid and self.velocity_count else None)
                self.velocity_energy = self.velocity_count = 0
                self.velocity_valid = True
                self._window(mean, spread, batch.sample_start + min(end * stride, len(batch.values)), window / rssi_rate, rms)
                if self.trigger is not None:
                    break
        if length < expected_rssi and self.trigger is None:
            self._gap("missing_rssi_samples")
        return self.status

    def _window(self, mean, spread, sample_end, seconds, velocity_rms=None):
        elapsed = (sample_end - self.origin) / self.rate
        self.status.update(latestRssi=mean, rssiSpread=spread)
        if elapsed < self.config.rssiMinimumSeconds:
            self.entry_ms = self.exit_ms = self.baseline_exit_ms = 0.0
            self.status.update(rssiEntryMs=0, rssiBelowMs=0)
            return
        if self.entry_evidence_mode != "off":
            self.evidence.window(mean, spread, velocity_rms, entry_starting=self.entry_ms == 0, armed=self.armed)
        if self.observe_background and not self.armed:
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
                if self.require_background and spread >= self.config.rssiEnterSpread and not self.partial_seen:
                    self.partial_seen = True
                    self.status["rssiPartialPassesIgnored"] += 1
                    self._phase("partial_pass_ignored", sample_end)
                elif self.require_background:
                    self._phase("waiting_background", sample_end)
            if self.require_background and not self.background_ready:
                return
        if self.revalidate_entry_clear and self.entry_edge_ready and not self.armed:
            # Quiet qualification is not a permanent permit. Until entry is
            # confirmed, revoke it when a short candidate breaks or the recent
            # sub-entry means drift. Keep the same 30 ms rolling sample window;
            # a clean direct edge still arms in the existing 20 ms.
            reason = None
            if self.entry_ms > 0 and spread < self.config.rssiEnterSpread:
                reason = "interrupted_entry"
            elif self.entry_ms == 0 and spread < self.config.rssiEnterSpread:
                self.entry_clear_values.append((mean, seconds * 1000))
                duration = sum(v[1] for v in self.entry_clear_values)
                while len(self.entry_clear_values) > 1 and duration - self.entry_clear_values[0][1] + 1e-6 >= self.config.rssiConfirmMs:
                    duration -= self.entry_clear_values.popleft()[1]
                mean_range = max(v[0] for v in self.entry_clear_values) - min(v[0] for v in self.entry_clear_values)
                self.status["rssiEntryMeanRange"] = mean_range
                if mean_range > self.config.rssiExitSpread:
                    reason = "post_clear_mean_drift"
            if reason:
                self.arrival_disturbance_seen = True
                self.entry_edge_ready = False
                self.entry_clear_values.clear()
                self.entry_clear_ms = self.entry_ms = 0.0
                self.entry_clear_sample = None
                self.entry_start = self.entry_confirmed = None
                self.status.update(rssiEntryEdgeReady=False, rssiEntryClearMs=0, rssiEntryMs=0,
                                   rssiEntryClearRevocations=self.status["rssiEntryClearRevocations"] + 1)
                self.events.append({"phase": "entry_clear_revoked", "reason": reason,
                                    "sampleIndex": sample_end - 1,
                                    "sampleElapsedSeconds": elapsed, "rssiSpread": spread})
        if not self.entry_edge_ready:
            # Qualify only the initial clear interval (also after a signal gap).
            # Small within-window spread can hide drift between windows. Use
            # the SAME confirmation duration, retaining a rolling stable suffix;
            # no fixed post-arrival sleep or exit-baseline matching is added.
            if self.require_stable_entry_mean:
                if spread <= self.config.rssiExitSpread:
                    self.entry_clear_values.append((mean, seconds * 1000))
                    mean_range = max(v[0] for v in self.entry_clear_values) - min(v[0] for v in self.entry_clear_values)
                    self.status["rssiEntryMeanRange"] = mean_range
                    if mean_range > self.config.rssiExitSpread:
                        self.arrival_disturbance_seen = True
                        self.status["rssiEntryDriftResets"] += 1
                    while (max(v[0] for v in self.entry_clear_values) - min(v[0] for v in self.entry_clear_values)
                           > self.config.rssiExitSpread):
                        self.entry_clear_values.popleft()
                    self.entry_clear_ms = sum(v[1] for v in self.entry_clear_values)
                    while (len(self.entry_clear_values) > 1 and
                           self.entry_clear_ms - self.entry_clear_values[0][1] + 1e-6 >= self.config.rssiConfirmMs):
                        self.entry_clear_ms -= self.entry_clear_values.popleft()[1]
                else:
                    self.arrival_disturbance_seen = True
                    self.entry_clear_values.clear()
                    self.entry_clear_ms = 0.0
                    self.status["rssiEntryMeanRange"] = None
            else:
                self.entry_clear_ms = (self.entry_clear_ms + seconds * 1000
                                       if spread <= self.config.rssiExitSpread else 0.0)
            self.status["rssiEntryClearMs"] = self.entry_clear_ms
            if self.entry_clear_ms + 1e-6 >= self.config.rssiConfirmMs:
                self.entry_edge_ready = True
                self.entry_clear_sample = sample_end - 1
                if not self.revalidate_entry_clear:
                    self.entry_clear_values.clear()
                self.status["rssiEntryEdgeReady"] = True
                self._phase("entry_clear_confirmed", sample_end)
                self._phase("waiting_blade", sample_end)
            else:
                self._phase("waiting_entry_clear", sample_end)
            return
        if not self.armed:
            if spread >= self.config.rssiEnterSpread and self.entry_ms == 0:
                self.entry_start = max(self.origin, sample_end - round(seconds * self.rate))
                if self.observe_background and self.background_ready:
                    self.entry_baseline = self.status["rssiBackgroundMean"]
                    self.entry_baseline_tolerance = max(2 * self.config.rssiExitSpread,
                                                         self.config.rssiEnterSpread * .75)
            self.entry_ms = self.entry_ms + seconds * 1000 if spread >= self.config.rssiEnterSpread else 0.0
            if self.entry_ms == 0:
                self.entry_start = None
            self.status["rssiEntryMs"] = self.entry_ms
            self._phase("confirming_entry" if self.entry_ms else "waiting_blade", sample_end)
            if self.entry_ms + 1e-6 >= self.config.rssiEnterConfirmMs:
                if self.entry_evidence_mode != "off":
                    evidence = self.evidence.result()
                    if self.entry_evidence_mode == "arrival_guard":
                        after_clear_ms = (1000 * (self.entry_start - self.entry_clear_sample - 1) / self.rate
                                          if self.entry_clear_sample is not None else None)
                        risky = (self.arrival_disturbance_seen and after_clear_ms is not None
                                 and after_clear_ms <= seconds * 1000 + 1e-6)
                        # RSSI variation already met enterConfirmMs. Require
                        # velocity corroboration only for a fresh edge directly
                        # following disturbed arrival/requalification. A mean
                        # jump alone cannot corroborate these risky candidates.
                        evidence.update(arrivalCandidateGuarded=risky,
                                        arrivalDisturbanceSeen=self.arrival_disturbance_seen,
                                        entryAfterClearMs=after_clear_ms,
                                        jointSupported=not risky or evidence["velocitySupported"])
                        if risky and not evidence["velocitySupported"]:
                            self.status.update(rssiEntryEvidence=evidence,
                                rssiArrivalEvidenceRejections=self.status["rssiArrivalEvidenceRejections"] + 1,
                                rssiEntryMs=0, rssiEntryEdgeReady=False, rssiEntryClearMs=0)
                            self.events.append({"phase": "arrival_evidence_rejected",
                                "sampleIndex": sample_end - 1, "sampleElapsedSeconds": elapsed,
                                "rssiSpread": spread, "entryEvidence": dict(evidence),
                                "reason": "disturbed_arrival_without_velocity_corroboration"})
                            self.entry_edge_ready = False
                            self.entry_clear_values.clear()
                            self.entry_clear_ms = self.entry_ms = 0.0
                            self.entry_start = self.entry_confirmed = self.entry_clear_sample = None
                            self._phase("waiting_entry_clear", sample_end)
                            return
                    self.status["rssiEntryEvidence"] = evidence
                    if not evidence["supported"]:
                        self.status["rssiUnsupportedEntries"] += 1
                        if self.entry_evidence_mode == "required":
                            self.entry_ms = 0
                            self.entry_start = self.entry_confirmed = None
                            self.status["rssiEntryMs"] = 0
                            self._phase("entry_evidence_rejected", sample_end)
                            return
                    self.accepted_evidence = evidence
                self.armed = True
                self.entry_confirmed = sample_end - 1
                self._phase("blade_present", sample_end)
            return
        # Only a continuous low-variation interval confirms exit after entry.
        returned_to_baseline = (self.entry_baseline is not None and
                                abs(mean - self.entry_baseline) <= self.entry_baseline_tolerance)
        exit_window = spread <= self.config.rssiExitSpread and (not self.require_background or returned_to_baseline)
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
        self.baseline_exit_ms = (self.baseline_exit_ms + seconds * 1000
                                 if exit_window and returned_to_baseline else 0.0)
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
                            "detectorVersion": 8 if self.entry_evidence_mode == "arrival_guard" else 7 if self.revalidate_entry_clear else 6 if self.entry_evidence_mode == "required" else 5 if self.require_stable_entry_mean else 4 if self.require_fresh_entry else 3 if self.background_advisory else 2 if self.require_background else 1,
                            "entryEvidenceMode": self.entry_evidence_mode,
                            "entryEvidence": self.accepted_evidence,
                            "unsupportedEntryCandidates": self.status["rssiUnsupportedEntries"],
                            "arrivalEvidenceRejections": self.status["rssiArrivalEvidenceRejections"],
                            "backgroundPolicy": "advisory" if self.background_advisory else "required" if self.require_background else "disabled",
                            "passCompleteness": ("unconfirmed" if self.background_advisory and self.baseline_exit_ms + 1e-6 < self.config.rssiConfirmMs else "confirmed"),
                            "completenessReason": ("missing_initial_background" if self.background_advisory and self.entry_baseline is None else
                                                   "exit_baseline_mismatch" if self.background_advisory and self.baseline_exit_ms + 1e-6 < self.config.rssiConfirmMs else None),
                            "requireBackground": self.require_background,
                            "requireFreshEntry": self.require_fresh_entry,
                            "requireStableEntryMean": self.require_stable_entry_mean,
                            "entryMeanRangeLimitPp": self.config.rssiExitSpread if self.require_stable_entry_mean else None,
                            "entryDriftResets": self.status["rssiEntryDriftResets"],
                            "entryClearRevalidation": self.revalidate_entry_clear,
                            "entryClearRevocations": self.status["rssiEntryClearRevocations"],
                            "entryClearConfirmedSampleIndex": self.entry_clear_sample,
                            "entryClearRequiredMs": self.config.rssiConfirmMs if self.require_fresh_entry else 0,
                            "backgroundConfirmedSampleIndex": self.background_sample,
                            "backgroundRequiredMs": self.status["rssiBackgroundRequiredMs"],
                            "baselineRssi": self.entry_baseline,
                            "baselineTolerancePp": self.entry_baseline_tolerance,
                            "partialPassesIgnored": self.status["rssiPartialPassesIgnored"],
                            "baselineMismatches": self.status["rssiBaselineMismatches"]}
            self.status["rssiTrigger"] = "blade_left"
            self._phase("blade_left", sample_end)
