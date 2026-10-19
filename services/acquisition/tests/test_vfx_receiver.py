"""Protocol fixtures only: no socket, SDK binary, laser or motor is opened."""
import csv
import hashlib
import json
import os
import shutil
from dataclasses import replace
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from blade_acquisition.receiver import Batch, PolytecReceiver, ReceiverConfig, VELOCITY, RSSI
from blade_acquisition.rssi_handoff import RssiHandoff
from blade_acquisition.service import AcquisitionController, Settings
from blade_acquisition.storage import HEADER, RECORD, RecordingStore
from blade_acquisition.waveform import WaveformReader, make_wave
from blade_acquisition.analysis import read_raw
from blade_acquisition.native_capture import validate_capture, import_capture
from export_csv import export
from test_service import FakeSdk
from test_rssi_handoff import config as handoff_config, blade_values


class VfxSdk(FakeSdk):
    def __init__(self):
        super().__init__()
        self.protocol = 4
        self.base_rate = 1000
        self.velocity_rate = 8000
        self.capabilities = {46, 592, 816, 918, 920, 978, 986, 1058}
        self.mode = b'Block'
        self.enabled = set()
        self.unavailable = set()
        self.reads = []
        self.events = []
        self.iq_mode = 0
        self.freed = []
        self.mode_stuck = self.laser_stuck = False
        self.bad_rssi_count = False

    def PolyOpenDataAcquisition(self, pointer, communication, capacity):
        self.capacity = capacity
        return super().PolyOpenDataAcquisition(pointer, communication, capacity)

    def PolyHasCommand(self, _, device, __, command, pointer):
        pointer._obj.value = command in self.capabilities
        return 0

    def PolySendGetInt16(self, _, device, __, command, pointer):
        if command == 592:
            pointer._obj.value = self.protocol
        elif command == 46:
            pointer._obj.value = 1 if self.laser_stuck else (self.laser_commands[-1] if self.laser_commands else 0)
        else:
            raise AssertionError(f'unexpected Int16 command {command}')
        return 0

    def PolySendGetInt32(self, _, device, __, command, pointer):
        self.assert_command(command, {918, 986})
        pointer._obj.value = self.velocity_rate if command == 918 else self.base_rate
        return 0

    @staticmethod
    def assert_command(command, choices):
        if command not in choices:
            raise AssertionError(f'unexpected command {command}')

    def PolySendGetWithTag(self, _, device, __, command, tag, pointer):
        assert (device, command, tag) == (1, 1058, 32)
        pointer._obj.value = 99
        return 0

    def PolyGetInt16FromPayload(self, handle, pointer, count, maximum):
        assert (handle, maximum) == (99, 1)
        pointer._obj.value = self.iq_mode
        count._obj.value = 1
        return 0

    def PolyFreePayload(self, handle):
        self.freed.append(handle)

    def PolySendGetString(self, *args):
        raise AssertionError('TCP VFX must not read UDP destination')

    def PolySendSetString(self, *args):
        raise AssertionError('TCP VFX must not write UDP destination')

    def PolyStopDataAcquisition(self, *_):
        self.events.append('stop')
        return 0

    def PolyItemListGetCurrentItem(self, *args):
        args[-2].value = self.mode if args[3] == 920 else b'1 m/s'
        return 0

    def PolyItemListGetAvailableItems(self, *args):
        assert args[3] == 920
        args[-2].value = b'Streaming,Block'
        return 0

    def PolyItemListSetCurrentItem(self, *args):
        assert args[3] == 920 and args[-1] == b'Streaming'
        self.events.append('streaming')
        if not self.mode_stuck:
            self.mode = args[-1]
        return 0

    def PolyChannelActivationIsChannelAvailable(self, _, channel, __, pointer):
        pointer._obj.value = channel not in self.unavailable
        return 0

    def PolyChannelActivationIsChannelEnabled(self, _, channel, __, pointer):
        pointer._obj.value = channel in self.enabled
        return 0

    def PolyChannelActivationEnableChannel(self, _, channel, __):
        self.enabled.add(channel)
        self.events.append(f'enable-{channel}')
        return 0

    def PolyBaseSampleRateInHz(self, _, pointer):
        pointer._obj.value = self.base_rate
        return 0

    def PolyChannelMaxValue(self, _, channel, pointer):
        pointer._obj.value = (2**31 - 1) if channel == VELOCITY else 511
        return 0

    def PolyStartDataAcquisition(self, *_):
        self.events.append('start')
        return 0

    def PolyReadData(self, _, base_count, timeout):
        self.reads.append(base_count)
        return 0

    def PolyExtractedSampleCount(self, _, channel, __, pointer):
        pointer._obj.value = self.reads[-1] * (self.velocity_rate // self.base_rate if channel == VELOCITY else 1)
        if channel == RSSI and self.bad_rssi_count:
            pointer._obj.value -= 1
        return 0

    def PolyGetInt32Data(self, _, channel, __, values, count):
        for index in range(count):
            values[index] = ((2**31-1) if index % 2 else -(2**31-1)) if channel == VELOCITY else (511 if index % 2 else 0)
        return 0


def sparse_batch(start=0):
    return Batch(start, 8000., 1700000000., [1] * 8, [.01] * 8,
                 [102, 409], [20., 80.], [False] * 8, rssi_sample_stride=4)


class VfxReceiverTests(unittest.TestCase):
    def receiver(self):
        return PolytecReceiver(ReceiverConfig('192.0.2.90', '192.0.2.10', 'fixture-only', buffer_capacity=512))

    def run_sdk(self, sdk, count=2, receive=None):
        receiver, stop, batches, ready = self.receiver(), threading.Event(), [], []
        def on_receive(batch):
            batches.append(batch)
            if receive:
                receive(batch)
            if len(batches) == count:
                stop.set()
        with patch.object(receiver, '_load_api', return_value=sdk):
            receiver.run(stop, lambda *args: ready.append(args), on_receive)
        return receiver, batches, ready

    def test_vfx_real_sample_rate_sparse_rssi_bounded_reads_and_cleanup(self):
        sdk = VfxSdk()
        receiver, batches, ready = self.run_sdk(sdk)
        self.assertEqual(ready[0][0], 8000)
        self.assertEqual(sdk.reads, [50, 50])
        self.assertEqual(sdk.capacity, 64)  # 512 velocity samples / 8 samples per base sample.
        self.assertEqual([len(b.values) for b in batches], [400, 400])
        self.assertEqual([len(b.rssi) for b in batches], [50, 50])
        self.assertEqual(batches[1].sample_start, 400)
        self.assertEqual(batches[0].rssi_sample_stride, 8)
        self.assertEqual(batches[0].values[:2], [-1., 1.])
        self.assertEqual(batches[0].rssi[:2], [0., 100.])
        self.assertEqual(receiver.acquisition_metadata['dataTransport'], 'tcp')
        self.assertEqual(receiver.acquisition_metadata['rssiSampleRate'], 1000)
        self.assertEqual(sdk.events, ['stop', 'streaming', 'enable-2', 'enable-3', 'start', 'stop'])
        self.assertEqual(sdk.laser_commands, [1, 0])
        self.assertEqual(sdk.closed, ['acquisition', 'communication'])
        self.assertEqual(sdk.freed, [99])

    def test_vfx_invalid_configuration_never_lights_laser(self):
        cases = [('rate', lambda s: setattr(s, 'velocity_rate', 8001)),
                 ('unsupported protocol', lambda s: setattr(s, 'protocol', 99)),
                 ('missing rate', lambda s: s.capabilities.remove(918)),
                 ('IQ mode', lambda s: setattr(s, 'iq_mode', 1)),
                 ('unavailable RSSI', lambda s: s.unavailable.add(RSSI)),
                 ('mode not confirmed', lambda s: setattr(s, 'mode_stuck', True))]
        for name, configure in cases:
            with self.subTest(name=name):
                sdk = VfxSdk()
                configure(sdk)
                with self.assertRaises(RuntimeError):
                    self.run_sdk(sdk)
                self.assertEqual(sdk.laser_commands, [])
                self.assertEqual(sdk.closed[-1], 'communication')

    def test_vfx_channel_count_mismatch_and_disk_failure_stop_and_close(self):
        for disk_failure in (False, True):
            sdk = VfxSdk()
            sdk.bad_rssi_count = not disk_failure
            def fail(_):
                raise OSError('fixture disk full')
            with self.assertRaises(RuntimeError):
                self.run_sdk(sdk, receive=fail if disk_failure else None)
            self.assertEqual(sdk.laser_commands, [1, 0])
            self.assertEqual(sdk.events[-1], 'stop')
            self.assertEqual(sdk.closed, ['acquisition', 'communication'])

    def test_laser_off_readback_failure_is_not_reported_as_success(self):
        sdk = VfxSdk()
        sdk.laser_stuck = True
        with self.assertRaisesRegex(RuntimeError, 'Laser off'):
            self.run_sdk(sdk, count=1)
        self.assertEqual(sdk.closed, ['acquisition', 'communication'])

    def test_existing_streaming_channels_do_not_get_rewritten(self):
        sdk = VfxSdk()
        sdk.mode = b'Streaming'
        sdk.enabled = {VELOCITY, RSSI}
        self.run_sdk(sdk, count=1)
        self.assertEqual(sdk.events, ['stop', 'start', 'stop'])

    def test_unsupported_destination_is_not_guessed_for_udp(self):
        sdk = FakeSdk()
        original = sdk.PolyHasCommand
        def has(*args):
            result = original(*args)
            if args[3] == 90:
                args[-1]._obj.value = False
            return result
        sdk.PolyHasCommand = has
        def forbidden(*_):
            raise AssertionError('unsupported destination command')
        sdk.PolySendGetString = sdk.PolySendSetString = forbidden
        self.run_sdk(sdk, count=1)


class SparseRssiTests(unittest.TestCase):
    def test_live_rows_raw_file_preview_and_csv_keep_sparse_timestamps(self):
        with tempfile.TemporaryDirectory() as directory:
            controller = AcquisitionController(Settings('t' * 40, 8765, Path(directory)))
            writer = controller.store.create({'source': 'polytec_ivs500', 'name': 'VFX fixture'})
            controller.writer = writer
            controller._ready(8000., 1700000000.)
            controller._receive(sparse_batch())
            controller._receive(sparse_batch(8))
            writer.finish(None)
            rows = list(controller.rows)
            self.assertEqual([row[0] for row in rows if row[2] is not None], [0, 4, 8, 12])
            self.assertEqual(writer.manifest['rssiSampleRate'], 2000)
            self.assertEqual(writer.manifest['missingRssiSamples'], 12)
            self.assertEqual(writer.manifest['rssiNotSampledVelocitySamples'], 12)
            self.assertEqual(writer.manifest['rssiMissingExpectedSamples'], 0)
            binary = (writer.directory / 'chunk-00000000.bin').read_bytes()
            stored = list(RECORD.iter_unpack(binary[HEADER.size:]))
            self.assertEqual([row[0] for row in stored if row[5] & 2], [0, 4, 8, 12])
            self.assertEqual([row[3] for row in stored if row[5] & 2], [102, 409, 102, 409])
            preview = controller.store.get(writer.id)['waveform']
            self.assertEqual(preview['rssi'][:8], [20., None, None, None, 80., None, None, None])
            self.assertEqual(preview['rssiSampleStride'], 4)
            frame = controller.frame()
            self.assertEqual(frame['waveform']['missingRssiCount'], 0)
            self.assertEqual(frame['waveform']['latest']['rssi'], 80.)
            self.assertEqual(frame['waveform']['latest']['rssiSampleIndex'], 12)
            self.assertEqual(frame['realtime']['quality']['missingRssiSamples'], 0)
            output = Path(directory) / 'capture.csv'
            self.assertEqual(export(writer.directory, output), 16)
            with output.open(encoding='utf-8-sig') as stream:
                exported = list(csv.DictReader(stream))
            self.assertEqual([float(row['time_s']) for row in exported if row['rssi_raw']], [0, .0005, .001, .0015])

    def test_sparse_quality_in_raw_envelope_analysis_and_cloud_roundtrip(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = RecordingStore(root / 'source')
            writer = store.create({'source': 'polytec_ivs500', 'name': 'VFX sparse timing'})
            writer.ready(8000., 1700000000.)
            for start in range(0, 20000, 8):
                writer.write(sparse_batch(start))
            writer.finish(None)
            reader = WaveformReader(store)
            for start, end in ((0, 64), (1, 19999), (0, 20000)):
                wave = reader.read(writer.id, start, end)['waveform']
                self.assertEqual(wave['missingRssiCount'], 0)
                self.assertEqual(wave['rssiSampleStride'], 4)
            _, rate, source = read_raw(store, writer.id, 0, 20000)
            self.assertEqual(rate, 8000)
            self.assertEqual(source['missingRssiSamples'], 0)
            target = root / 'cloud' / ('b' * 32) / 'complete'
            shutil.copytree(writer.directory, target)
            files = [{'name': p.name, 'bytes': p.stat().st_size,
                      'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
                     for p in target.glob('*.bin')]
            (target / 'transfer.json').write_text(json.dumps({'files': files}))
            with patch.dict(os.environ, {'BLADE_CAPTURE_DATA_DIR': str(root / 'cloud')}):
                manifest = validate_capture(target)
                self.assertEqual(manifest['rssiSampleStride'], 4)
                imported = import_capture(RecordingStore(root / 'analysis'), target)['recording']
                self.assertEqual(imported['rssiSampleRate'], 2000)
                # A forged faster/slower RSSI rate must not silently alter quality.
                manifest['rssiSampleRate'] = 4000
                (target / 'manifest.json').write_text(json.dumps(manifest))
                with self.assertRaisesRegex(ValueError, 'RSSI'):
                    validate_capture(target)

    def test_sparse_waveform_counts_only_missing_expected_samples(self):
        rows = [(i, .01, 80. if i % 4 == 0 and i != 8 else None, False) for i in range(5000)]
        for selected in (rows[:64], rows[1:4999]):
            wave = make_wave(selected, 8000, 1700000000, rssi_stride=4)
            self.assertEqual(wave['missingRssiCount'], 1)

    def test_rssi_handoff_uses_rssi_rate_and_keeps_velocity_sample_indices(self):
        rssis = [62.] * 100 + blade_values(50) + [53.] * 50
        detector = RssiHandoff(handoff_config(), 0)
        # Deliberately split a 10 ms RSSI window over several SDK batches.
        for offset in range(0, len(rssis), 7):
            values = rssis[offset:offset+7]
            detector.feed(Batch(offset*8, 8000, 1700000000, [0]*(len(values)*8),
                                [0.]*(len(values)*8), [0]*len(values), values,
                                [False]*(len(values)*8), rssi_sample_stride=8))
        self.assertEqual(detector.trigger['sampleIndex'], 180*8-1)
        self.assertAlmostEqual(detector.trigger['sampleElapsedSeconds'], .18)
        self.assertAlmostEqual(detector.trigger['confirmedMs'], 30)

    def test_stride_change_or_missing_expected_rssi_resets_confirmation(self):
        for missing in (False, True):
            detector = RssiHandoff(handoff_config(), 0)
            first = Batch(0, 8000, 1700000000, [0]*400, [0.]*400,
                          [0]*50, blade_values(50), [False]*400, rssi_sample_stride=8)
            detector.feed(first)
            self.assertTrue(detector.armed)
            next_batch = replace(first, sample_start=400, rssi=[] if missing else [53.]*50,
                                 rssi_sample_stride=8 if missing else 4)
            detector.feed(next_batch)
            self.assertFalse(detector.armed)
            self.assertIsNone(detector.trigger)

    def test_storage_rejects_stride_changes_before_writing(self):
        with tempfile.TemporaryDirectory() as directory:
            writer = RecordingStore(Path(directory)).create({'source': 'polytec_ivs500'})
            writer.ready(8000., 1700000000.)
            writer.write(sparse_batch())
            with self.assertRaises(ValueError):
                writer.write(replace(sparse_batch(8), rssi_sample_stride=2))
            writer.finish('fixture ended')
            self.assertEqual(writer.manifest['samples'], 8)


if __name__ == '__main__':
    unittest.main()
