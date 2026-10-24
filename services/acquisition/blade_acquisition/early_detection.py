"""Opt-in diagnostic detection during movement, with an optional target-angle gate.

This observer never commands a motor. The normal motion owner must still finish
and verify stop before consuming a remembered pass and commanding the next point.
Samples and trigger indices use the continuous raw archive clock, not the later
station record's clock. These records are diagnostic, not valid measurements.
"""
import copy
import math
import time
import threading
from .receiver import Batch
from .rssi_handoff import RssiHandoff


class EarlyPointDetection:
    def __init__(self, config, point, fence, lock=None):
        self.lock = lock if lock is not None else threading.RLock()
        self.point = point
        self.config = config
        self.tolerance = config.diagnosticAngleWindowDeg or None
        self.fence_reader = fence
        self.detector = RssiHandoff(config, 0.0)
        self.active = False
        self.fence = None
        self.armed_at = None
        self.feedback_at = None
        self.stop_confirmed_at = None
        self.resets = 0

    def observe(self, feedback, *, stopped=False):
        # Called by the motion owner WITHOUT holding the controller lock.
        # A fence is serviced by the receive thread, which must acquire that
        # same lock to archive drained samples before acknowledging the fence.
        now = time.time()
        axes = feedback.get('axes', {})
        feedback_valid = all(isinstance(axes.get(str(axis), {}).get('output_angle_deg'), (int, float))
                   and math.isfinite(axes[str(axis)]['output_angle_deg'])
                   and (self.tolerance is None or abs(axes[str(axis)]['output_angle_deg'] -
                        (self.point.axis1AngleDeg if axis == 1 else self.point.axis2AngleDeg)) <= self.tolerance)
                   and not axes[str(axis)].get('fault')
                   for axis in (1, 2))
        with self.lock:
            if not feedback_valid:
                if self.active:
                    self.resets += 1
                    self.detector = RssiHandoff(self.config, 0.0)
                self.active = False
                return
            if self.active:
                self.feedback_at = now
                if stopped:
                    self.stop_confirmed_at = now
                return
            # Keep detection closed while old SDK batches are drained. There
            # is one motion owner; the receiver cannot arm this observer.
            self.active = False
        fence = self.fence_reader()['sampleIndex']
        with self.lock:
            self.fence = fence
            self.detector = RssiHandoff(self.config, 0.0)
            self.armed_at = time.time()
            self.active = True
            self.feedback_at = now
            self.stop_confirmed_at = now if stopped else None

    def feed(self, batch):
        if not self.active:
            return
        # Diagnostic detection still requires fresh, fault-free motion feedback.
        # Stationary capture uses normal pose checks.
        if self.stop_confirmed_at is None and time.time()-self.feedback_at > .5:
            self.active = False
            self.resets += 1
            self.detector = RssiHandoff(self.config, 0.0)
            return
        stride = batch.rssi_sample_stride
        first = max(batch.sample_start, self.fence)
        first = ((first+stride-1)//stride)*stride
        offset = first-batch.sample_start
        if offset >= len(batch.values):
            return
        clipped = Batch(first, batch.sample_rate, batch.started_at,
                        batch.velocity_raw[offset:], batch.values[offset:],
                        batch.rssi_raw[offset//stride:], batch.rssi[offset//stride:],
                        batch.overrange[offset:], stride)
        self.detector.feed(clipped)
        if self.detector.trigger is not None:
            self.detector.trigger.setdefault('detectedAt', time.time())
            self.detector.trigger.setdefault('detectedBeforeStoppedArrival', self.stop_confirmed_at is None)
            self.detector.trigger['sampleClock'] = 'continuous_session_raw'

    def evidence(self):
        return dict(enabled=True, angleGateEnabled=self.tolerance is not None, toleranceDeg=self.tolerance, armedAt=self.armed_at,
                    bufferFence=self.fence, stopConfirmedAt=self.stop_confirmed_at,
                    resets=self.resets, sampleClock='continuous_session_raw',
                    validMeasurement=False, trigger=copy.deepcopy(self.detector.trigger))
