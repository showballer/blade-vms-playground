"""Bounded live previews; no SDK, network, disk or motion calls."""
from dataclasses import replace
import unittest

import numpy as np

from blade_acquisition.continuous_preview import (ContinuousPreviewBuffer, MAX_PREVIEW_BLOCKS,
                                                  MAX_PREVIEW_SAMPLES)
from blade_acquisition.receiver import Batch
from blade_acquisition.waveform import make_wave


def batch(start, count, rate=250000, stride=4):
    values = np.arange(start, start + count, dtype=float)
    return Batch(start, rate, 100.0, [], values, [], np.arange((count + stride - 1) // stride,
                 dtype=float), values % 7 == 0, stride)


class ContinuousPreviewTests(unittest.TestCase):
    def test_record_origin_must_align_but_display_tail_keeps_original_sparse_phase(self):
        preview = ContinuousPreviewBuffer()
        preview.append(batch(100, 40))
        with self.assertRaisesRegex(ValueError, "对齐"):
            preview.window(101, 134, 250000, 100, 4)
        wave, _ = preview.window(104, 134, 250000, 100, 4).frame(.02)
        self.assertEqual(wave['sampleStart'], 25)  # The five-sample chart tail is not RSSI aligned.
        self.assertEqual(wave['rssi'], [None, None, None, 8.0, None])
        self.assertEqual(wave['missingRssiCount'], 0)
        self.assertEqual(wave['latest']['rssiSampleIndex'], 28)
        self.assertEqual(wave['latest']['rssi'], 8.0)
        self.assertAlmostEqual(wave['sampleOrigin'] + 28 / wave['sampleRate'], 100 + 132 / 250000)

    def test_local_clock_sparse_rssi_and_flags_match_eventual_record(self):
        preview = ContinuousPreviewBuffer()
        source = batch(100, 40)
        preview.append(source)
        snapshot = preview.window(104, 133, source.sample_rate, source.started_at, 4)
        wave, realtime = snapshot.frame(1000)
        rows = [(i - 104, float(i), float((i - 100) // 4) if i % 4 == 0 else None,
                 i % 7 == 0) for i in range(104, 133)]
        expected = make_wave(rows, 250000, 100 + 104 / 250000, rssi_stride=4)
        self.assertEqual(wave, expected)
        self.assertEqual(realtime, rows)
        source.values[:] = -9
        source.rssi[:] = -9
        source.overrange[:] = False
        self.assertEqual(snapshot.frame(1000), (wave, realtime), 'SDK buffers must not mutate preview')

    def test_wide_view_has_same_envelope_and_real_fft_tail(self):
        preview = ContinuousPreviewBuffer()
        source = batch(1000, 10000)
        preview.append(source)
        snapshot = preview.window(1004, 10901, 250000, 100.0, 4)
        rows = [(i - 1004, float(i), float((i - 1000) // 4) if i % 4 == 0 else None,
                 i % 7 == 0) for i in range(1004, 10901)]
        wave, realtime = snapshot.frame(1000)
        self.assertEqual(wave, make_wave(rows, 250000, 100 + 1004 / 250000, rssi_stride=4))
        self.assertEqual(realtime, rows[-4096:])
        short, realtime = snapshot.frame(1)
        self.assertEqual(short, make_wave(rows[-250:], 250000, 100 + 1004 / 250000, rssi_stride=4))
        self.assertEqual(realtime, rows[-4096:])

    def test_history_and_single_huge_batch_are_bounded_and_partial_range_is_honest(self):
        preview = ContinuousPreviewBuffer()
        preview.append(batch(0, MAX_PREVIEW_SAMPLES * 3))
        self.assertLessEqual(sum(len(b.values) for b in preview.blocks), MAX_PREVIEW_SAMPLES)
        snapshot = preview.window(0, MAX_PREVIEW_SAMPLES * 3, 250000, 100, 4)
        wave, _ = snapshot.frame(10000)
        self.assertEqual(wave['rangeStart'], MAX_PREVIEW_SAMPLES * 2)
        self.assertEqual(wave['rangeEnd'], MAX_PREVIEW_SAMPLES * 3)
        self.assertEqual(wave['sourceSamples'], MAX_PREVIEW_SAMPLES)
        self.assertLessEqual(len(wave['envelope']), 1000)
        # Retaining a snapshot must not prevent the rolling buffer evicting old blocks.
        for i in range(750000, 1_250_000, 5000):
            preview.append(batch(i, 5000))
        self.assertLessEqual(sum(len(b.values) for b in preview.blocks), MAX_PREVIEW_SAMPLES + 5000)
        self.assertEqual(snapshot.frame(10000)[0], wave)

    def test_short_packets_have_bounded_object_count_and_keep_local_sparse_phase(self):
        preview = ContinuousPreviewBuffer()
        for i in range(400):
            preview.append(batch(i, 1, stride=1))
        self.assertLessEqual(len(preview.blocks), MAX_PREVIEW_BLOCKS)
        wave, _ = preview.window(0, 400, 250000, 100).frame(1000)
        self.assertEqual(wave['rangeStart'], 400 - MAX_PREVIEW_BLOCKS)
        self.assertEqual(wave['rangeEnd'], 400)

    def test_observations_missing_at_source_remain_missing(self):
        preview = ContinuousPreviewBuffer()
        preview.append(replace(batch(0, 16), rssi=[1.0, None]))
        wave, _ = preview.window(0, 16, 250000, 100, 4).frame(1000)
        self.assertEqual(wave['missingRssiCount'], 3)
        self.assertEqual(wave['rssi'][0], 1)
        self.assertTrue(all(r is None for r in wave['rssi'][1:]))

    def test_unaligned_large_batch_crop_preserves_envelope_rssi_phase(self):
        preview = ContinuousPreviewBuffer()
        end = MAX_PREVIEW_SAMPLES * 3 + 1
        preview.append(batch(0, end))
        wave, _ = preview.window(0, end, 250000, 100, 4).frame(1000)
        self.assertEqual(wave['rangeStart'], MAX_PREVIEW_SAMPLES * 2 + 1)
        self.assertEqual(wave['rangeEnd'], end)
        self.assertEqual(wave['missingRssiCount'], 0)
        self.assertEqual(wave['latest']['rssiSampleIndex'], end - 1)
        self.assertEqual(wave['latest']['rssi'], (end - 1) / 4)
