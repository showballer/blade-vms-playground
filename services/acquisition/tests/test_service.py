"""All acquisition data below is an explicit test fixture, never a runtime fallback."""
from __future__ import annotations

import ctypes as C
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from blade_acquisition.receiver import Batch, PolytecReceiver, ReceiverConfig, VELOCITY, RSSI, TIMEOUT
from blade_acquisition.service import Settings, create_app
from blade_acquisition.storage import HEADER, RECORD, RecordingStore, RecordingWriter
from export_csv import export

TOKEN = "unit-test-only-0123456789abcdef0123456789abcdef"
START = {"deviceIp": "192.168.104.50", "hostIp": "192.168.104.10", "name": "fixture capture",
         "object": "blade", "turbine": "T1", "point": "P1", "confirmLaser": True}


def batch(count=5000, start=0):
    return Batch(start, 218750.0, 1700000000.0, list(range(count)),
                 [index / 1_000_000 for index in range(count)], [20] * (count - 1),
                 [80.0] * (count - 1), [index == 2 for index in range(count)])


class FixtureReceiver:
    starts = 0

    def __init__(self, config):
        self.config = config

    def validate(self):
        pass

    def run(self, stop, ready, receive):
        type(self).starts += 1
        ready(218750.0, 1700000000.0)
        receive(batch())
        stop.wait(5)


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.settings = Settings(TOKEN, 8765, Path(self.temporary.name))
        self.app = create_app(self.settings, FixtureReceiver)
        self.client = TestClient(self.app, base_url="http://127.0.0.1:8765",
                                 headers={"Authorization": f"Bearer {TOKEN}"})
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.temporary.cleanup()

    def wait_for_samples(self):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            result = self.client.get("/api/field/frame").json()
            if result.get("recording", {}) and result["recording"]["samples"]:
                return result
            time.sleep(0.01)
        self.fail("fixture receiver did not deliver samples")

    def test_idle_does_not_start_device(self):
        previous = FixtureReceiver.starts
        result = self.client.get("/api/field/frame").json()
        self.assertEqual(result["state"], "idle")
        self.assertEqual(result["waveform"]["values"], [])
        self.assertIsNone(result["recording"])
        self.assertEqual(FixtureReceiver.starts, previous)
        self.assertEqual(result["receiver"]["channels"], ["CH1", "RSSI1"])

    def test_http_auth_origin_and_host(self):
        self.assertEqual(self.client.get("/api/field/status", headers={"Authorization": ""}).status_code, 401)
        self.assertEqual(self.client.get("/api/field/status", headers={"Origin": "https://attacker.invalid"}).status_code, 403)
        self.assertEqual(self.client.get("/api/field/status", headers={"Origin": "null"}).status_code, 403)
        self.assertEqual(self.client.get("/api/field/status", headers={"Host": "attacker.invalid"}).status_code, 403)
        self.assertEqual(self.client.get("/api/field/status").headers["cache-control"], "no-store")

    def test_explicit_safety_validation(self):
        for changes in ({"confirmLaser": False}, {"confirmLaser": "true"}, {"confirmLaser": 1},
                        {"deviceIp": "127.0.0.1"}, {"hostIp": "0.0.0.0"}, {"name": "  "}):
            with self.subTest(changes=changes):
                self.assertEqual(self.client.post("/api/field/start", json={**START, **changes}).status_code, 422)
        missing = dict(START)
        del missing["confirmLaser"]
        self.assertEqual(self.client.post("/api/field/start", json=missing).status_code, 422)

    def test_raw_capture_is_complete_but_frame_is_bounded(self):
        self.assertEqual(self.client.post("/api/field/start", json=START).status_code, 200)
        frame = self.wait_for_samples()
        self.assertEqual(frame["recording"]["samples"], 5000)
        self.assertEqual(len(frame["waveform"]["values"]), 2048)
        self.assertEqual(frame["waveform"]["sampleStart"], 2952)
        self.assertEqual(frame["waveform"]["unit"], "m/s")
        self.assertIsNone(frame["waveform"]["rssi"][-1])
        self.assertEqual(self.client.post("/api/field/start", json=START).status_code, 409)
        stopped = self.client.post("/api/field/stop").json()
        self.assertEqual(stopped["state"], "idle")
        self.assertEqual(stopped["recording"]["status"], "complete")
        record_id = stopped["recording"]["id"]
        directory = Path(self.temporary.name) / "recordings" / record_id
        chunks = list(directory.glob("*.bin"))
        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0].stat().st_size, HEADER.size + 5000 * RECORD.size)
        self.assertEqual(self.client.get("/api/field/recordings").json()["recordings"][0]["id"], record_id)
        preview = self.client.get(f"/api/field/recordings/{record_id}").json()
        self.assertEqual(len(preview["waveform"]["values"]), 2048)
        self.assertEqual(preview["recording"]["missingRssiSamples"], 1)
        self.assertEqual(self.client.post("/api/field/stop").status_code, 200)

    def test_disk_error_stops_and_never_publishes_unsaved_samples(self):
        with patch.object(RecordingWriter, "write", side_effect=OSError("fixture disk full")):
            self.client.post("/api/field/start", json=START)
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                result = self.client.get("/api/field/frame").json()
                if result["state"] == "error":
                    break
                time.sleep(0.01)
        self.assertEqual(result["state"], "error")
        self.assertIn("disk full", result["error"])
        self.assertEqual(result["waveform"]["values"], [])
        self.assertEqual(result["recording"]["status"], "error")

    def test_websocket_auth_and_protocol(self):
        with self.client.websocket_connect("ws://127.0.0.1:8765/ws/field", subprotocols=["blade", TOKEN]) as socket:
            self.assertEqual(socket.accepted_subprotocol, "blade")
            self.assertEqual(socket.receive_json()["state"], "idle")
        for protocols, headers in ((["blade", "wrong"], {}), (["blade", TOKEN], {"Origin": "https://evil.invalid"})):
            with self.assertRaises(WebSocketDisconnect):
                with self.client.websocket_connect("ws://127.0.0.1:8765/ws/field", subprotocols=protocols, headers=headers):
                    pass

    def test_missing_sdk_is_explicit_no_fallback(self):
        self.app.state.controller.receiver_factory = PolytecReceiver
        response = self.client.post("/api/field/start", json=START)
        self.assertEqual(response.status_code, 503)
        self.assertIn("DLL", response.json()["detail"])
        self.assertEqual(self.client.get("/api/field/frame").json()["waveform"]["values"], [])
        self.assertEqual(self.client.get("/api/field/recordings").json()["recordings"], [])

    def test_recording_ids_cannot_be_file_paths(self):
        self.assertEqual(self.client.get("/api/field/recordings/not-an-id").status_code, 404)
        self.assertEqual(self.client.get("/api/field/recordings/" + "f" * 32).status_code, 404)

    def test_range_api_is_authenticated_bounded_and_preserves_old_records(self):
        self.client.post("/api/field/start", json=START)
        frame = self.wait_for_samples()
        record_id = frame["recording"]["id"]
        route = f"/api/field/recordings/{record_id}/waveform"
        self.assertEqual(self.client.get(route, headers={"Authorization": ""}).status_code, 401)
        for query in ("?start=-1", "?start=2&end=1", "?end=0", "?start=9007199254740992", "?start=nan", "?end=1.5"):
            self.assertEqual(self.client.get(route + query).status_code, 422, query)
        result = self.client.get(route + "?start=5&end=12").json()
        self.assertEqual(result["waveform"]["sampleStart"], 5)
        self.assertEqual(len(result["waveform"]["values"]), 7)
        self.assertEqual(result["recording"]["status"], "incomplete")
        self.assertEqual(self.client.get("/api/field/frame?window_ms=1001").status_code, 422)
        wave = self.client.get("/api/field/frame?window_ms=20").json()["waveform"]
        self.assertEqual(wave["sourceSamples"], 4375)
        self.assertEqual(wave["representation"], "envelope")
        self.assertEqual(wave["rangeEnd"], 5000)

    def test_device_api_requires_confirmation_and_refuses_during_capture(self):
        with patch("blade_acquisition.service.DevicePanel") as panel:
            for body in ({"action": "read", "deviceIp": "127.0.0.1"},
                         {"action": "set", "deviceIp": START["deviceIp"], "key": "bandwidth", "value": "5 kHz"},
                         {"action": "autofocus", "deviceIp": START["deviceIp"]},
                         {"action": "autofocus", "deviceIp": START["deviceIp"], "confirmLaser": "true"},
                         {"action": "set", "deviceIp": START["deviceIp"], "key": "laser", "value": 1, "confirmChange": True}):
                self.assertEqual(self.client.post("/api/field/device", json=body).status_code, 422)
            self.assertFalse(panel.called)
            self.client.post("/api/field/start", json=START)
            self.wait_for_samples()
            self.assertEqual(self.client.post("/api/field/device", json={"action": "read", "deviceIp": START["deviceIp"]}).status_code, 409)
            self.assertFalse(panel.called)

    def test_device_failure_clears_verified_snapshot_and_releases_busy_state(self):
        with patch("blade_acquisition.service.DevicePanel") as panel:
            panel.return_value.run_command.return_value = {"deviceIp": START["deviceIp"], "fields": {}}
            request = {"action": "read", "deviceIp": START["deviceIp"]}
            self.assertEqual(self.client.post("/api/field/device", json=request).status_code, 200)
            self.assertIsNotNone(self.app.state.controller.device_snapshot)
            panel.return_value.run_command.side_effect = RuntimeError("fixture uncertain")
            self.assertEqual(self.client.post("/api/field/device", json=request).status_code, 503)
            self.assertIsNone(self.app.state.controller.device_snapshot)
            self.assertFalse(self.app.state.controller.device_busy)
            self.assertTrue(self.app.state.controller.operation_lock.acquire(blocking=False))
            self.app.state.controller.operation_lock.release()

    def test_slow_waveform_io_never_holds_acquisition_control_lock(self):
        self.client.post("/api/field/start", json=START)
        record_id = self.wait_for_samples()["recording"]["id"]
        reading, release = threading.Event(), threading.Event()
        def slow(*_args):
            reading.set()
            release.wait(3)
            return {"fixture": True}
        with patch.object(self.app.state.controller.wave_reader, "read", side_effect=slow):
            thread = threading.Thread(target=lambda: self.client.get(f"/api/field/recordings/{record_id}/waveform"))
            thread.start()
            try:
                self.assertTrue(reading.wait(2))
                response = self.client.post("/api/field/stop")
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["recording"]["status"], "complete")
                self.assertTrue(thread.is_alive(), "I/O fixture must still be blocked while stop completed")
            finally:
                release.set()
                thread.join(3)

    def test_uncertain_device_change_blocks_start_until_same_device_laser_off_readback(self):
        with patch("blade_acquisition.service.DevicePanel") as panel:
            panel.return_value.run_command.side_effect = RuntimeError("fixture uncertain write")
            request = {"action": "set", "deviceIp": START["deviceIp"], "key": "bandwidth", "value": "5 kHz", "expected": "10 kHz", "confirmChange": True}
            self.assertEqual(self.client.post("/api/field/device", json=request).status_code, 503)
            self.assertEqual(self.client.post("/api/field/start", json=START).status_code, 409)
            panel.return_value.run_command.side_effect = None
            for address, value, blocked in [("192.168.104.51", 0, True), (START["deviceIp"], 1, True), (START["deviceIp"], 0, False)]:
                panel.return_value.run_command.return_value = {"deviceIp": address, "fields": {"laser": {"supported": True, "value": value}}}
                self.assertEqual(self.client.post("/api/field/device", json={"action": "read", "deviceIp": address}).status_code, 200)
                self.assertEqual(bool(self.app.state.controller.device_warning), blocked)


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.store = RecordingStore(self.root)

    def tearDown(self):
        self.temporary.cleanup()

    def test_recover_partial_capture_and_tail_without_erasing_raw_file(self):
        writer = self.store.create({"name": "interrupted"})
        writer.ready(218750.0, 1700000000.0)
        writer.write(batch(100))
        writer.stream.write(b"x")
        writer.stream.close()
        writer.stream = None
        recovered = RecordingStore(self.root)
        record = recovered.list()[0]
        self.assertEqual(record["status"], "incomplete")
        self.assertEqual(record["samples"], 100)
        self.assertEqual(record["trailingBytes"], 1)
        raw = next((self.root / writer.id).glob("*.part"))
        self.assertEqual(raw.stat().st_size, HEADER.size + 100 * RECORD.size + 1)

    def test_corrupt_sqlite_is_rebuilt_from_manifest(self):
        writer = self.store.create({"name": "indexed"})
        writer.ready(218750.0, 1700000000.0)
        writer.write(batch(100))
        writer.finish(None)
        self.store.index_path.write_bytes(b"fixture corrupt sqlite")
        recovered = RecordingStore(self.root)
        self.assertEqual(recovered.list()[0]["samples"], 100)
        self.assertEqual(len(list(self.root.glob("recordings-corrupt-*"))), 1)

    def test_index_sequence_and_rate_are_enforced(self):
        writer = self.store.create({"name": "sequence"})
        writer.ready(218750.0, 1700000000.0)
        with self.assertRaises(ValueError):
            writer.write(batch(100, start=5))
        writer.finish("test finished")

    def test_chunk_rotation_and_timing_origin(self):
        writer = self.store.create({"name": "rotation"})
        writer.CHUNK_SAMPLES = 100
        writer.ready(218750.0, 1700000000.0)
        writer.write(batch(100))
        writer.write(batch(100, start=100))
        writer.finish(None)
        chunks = list((self.root / writer.id).glob("*.bin"))
        self.assertEqual(len(chunks), 2)
        headers = [HEADER.unpack(path.read_bytes()[:HEADER.size]) for path in sorted(chunks)]
        self.assertEqual(headers[0][2], headers[1][2])
        self.assertEqual(headers[1][3], 100)

    def test_export_csv_streams_exact_samples_and_refuses_overwrite(self):
        writer = self.store.create({"name": "CSV export"})
        writer.ready(218750.0, 1700000000.0)
        writer.write(batch(100))
        writer.finish(None)
        output = self.root / "test.csv"
        self.assertEqual(export(self.root / writer.id, output), 100)
        rows = output.read_text(encoding="utf-8-sig").splitlines()
        self.assertEqual(len(rows), 101)
        self.assertEqual(rows[0], "sample,time_s,velocity_raw,velocity_m_s,overrange,rssi_raw,rssi_percent")
        self.assertTrue(rows[-1].endswith(",,"))
        with self.assertRaises(FileExistsError):
            export(self.root / writer.id, output)

    def test_failed_finish_does_not_claim_complete(self):
        writer = self.store.create({"name": "finish failure"})
        writer.ready(218750.0, 1700000000.0)
        writer.write(batch(100))
        with patch("blade_acquisition.storage.os.fsync", side_effect=OSError("fixture fsync failure")):
            with self.assertRaises(OSError):
                writer.finish(None)
        manifest = json.loads((self.root / writer.id / "manifest.json").read_text())
        self.assertEqual(manifest["status"], "incomplete")
        self.assertEqual(writer.manifest["status"], "incomplete")

    def test_surplus_rssi_is_saved_without_inventing_second_velocity_channel(self):
        writer = self.store.create({"name": "surplus RSSI"})
        writer.ready(218750.0, 1700000000.0)
        value = batch(3)
        value.rssi_raw.extend([10, 11, 12])
        value.rssi.extend([10.0, 11.0, 12.0])
        writer.write(value)
        writer.finish(None)
        self.assertEqual(writer.manifest["unpairedRssiSamples"], 2)
        self.assertTrue((self.root / writer.id / "unpaired-rssi.bin").is_file())


class FakeSdk:
    def __init__(self, laser_timeout=False):
        self.laser_timeout = laser_timeout
        self.laser_commands = []
        self.closed = []

    def PolyOpenUdpEthernetCommunication(self, pointer, *_):
        pointer._obj.value = 1
        return 0

    def PolyOpenDataAcquisition(self, pointer, *_):
        pointer._obj.value = 2
        return 0

    def PolyLastCommunicationStatus(self, buffer, *_):
        buffer.value = b"fixture status"

    def PolySendGetString(self, *arguments):
        arguments[-2].value = b"192.168.104.10"
        return 0

    def PolySendSetString(self, *_):
        return 0

    def PolyStopDataAcquisition(self, *_):
        return 0

    def PolyBaseSampleRateInHz(self, _, pointer):
        pointer._obj.value = 218750.0
        return 0

    def PolyChannelMaxValue(self, _, channel, pointer):
        pointer._obj.value = 1000
        return 0

    def PolyItemListGetCurrentItem(self, *arguments):
        arguments[-2].value = b"10 mm/s"
        return 0

    def PolySendGetFloat(self, *arguments):
        arguments[-1]._obj.value = 1.0
        return 0

    def PolySendSetInt16(self, *arguments):
        value = arguments[-1].value
        self.laser_commands.append(value)
        return TIMEOUT if value and self.laser_timeout else 0

    def PolyStartDataAcquisition(self, *_):
        return 0

    def PolyReadData(self, *_):
        return 0

    def PolyExtractedSampleCount(self, *arguments):
        arguments[-1]._obj.value = 3
        return 0

    def PolyGetInt32Data(self, _, channel, __, values, count):
        for index in range(count):
            values[index] = index if channel == VELOCITY else 500
        return 0

    def PolyGetOverrange(self, _, __, ___, flags, count):
        for index in range(count):
            flags[index] = index == 2
        return 0

    def PolyCloseDataAcquisition(self, *_):
        self.closed.append("acquisition")

    def PolyCloseCommunication(self, *_):
        self.closed.append("communication")


class ReceiverTests(unittest.TestCase):
    def test_sdk_conversion_timing_and_laser_cleanup(self):
        receiver = PolytecReceiver(ReceiverConfig(START["deviceIp"], START["hostIp"], "fixture-only"))
        sdk, stop, batches = FakeSdk(), threading.Event(), []
        def receive(value):
            batches.append(value)
            if len(batches) == 2:
                stop.set()
        with patch.object(receiver, "_load_api", return_value=sdk):
            receiver.run(stop, lambda *_: None, receive)
        self.assertEqual(sdk.laser_commands, [1, 0])
        self.assertEqual(sdk.closed, ["acquisition", "communication"])
        self.assertEqual(batches[1].sample_start, 3)
        self.assertEqual(batches[0].started_at, batches[1].started_at)
        self.assertAlmostEqual(batches[0].values[2], 0.00002)
        self.assertEqual(batches[0].rssi, [50, 50, 50])
        self.assertEqual(batches[0].overrange, [False, False, True])

    def test_uncertain_laser_start_still_attempts_laser_off(self):
        receiver = PolytecReceiver(ReceiverConfig(START["deviceIp"], START["hostIp"], "fixture-only"))
        sdk = FakeSdk(laser_timeout=True)
        with patch.object(receiver, "_load_api", return_value=sdk):
            with self.assertRaisesRegex(RuntimeError, "Laser on"):
                receiver.run(threading.Event(), lambda *_: None, lambda *_: self.fail("should not acquire"))
        self.assertEqual(sdk.laser_commands, [1, 0])

    def test_missing_or_weak_service_token_is_rejected(self):
        with patch.dict("os.environ", {}, clear=True):
            with self.assertRaises(ValueError):
                Settings.from_environment()

    def test_disk_callback_failure_turns_laser_off(self):
        receiver = PolytecReceiver(ReceiverConfig(START["deviceIp"], START["hostIp"], "fixture-only"))
        sdk = FakeSdk()
        def fail_disk(_):
            raise OSError("fixture disk full")
        with patch.object(receiver, "_load_api", return_value=sdk):
            with self.assertRaisesRegex(RuntimeError, "disk full"):
                receiver.run(threading.Event(), lambda *_: None, fail_disk)
        self.assertEqual(sdk.laser_commands, [1, 0])


class EntrypointTests(unittest.TestCase):
    def test_real_http_process_starts_idle_and_stops_without_hardware(self):
        import urllib.error
        import urllib.request
        with tempfile.TemporaryDirectory() as directory:
            with socket.socket() as reservation:
                reservation.bind(("127.0.0.1", 0))
                port = reservation.getsockname()[1]
            environment = {**os.environ, "BLADE_SERVICE_TOKEN": TOKEN, "BLADE_SERVICE_PORT": str(port),
                           "BLADE_DATA_DIR": directory, "BLADE_POLYTEC_DLL": ""}
            process = subprocess.Popen([sys.executable, "-m", "blade_acquisition"], env=environment,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       cwd=Path(__file__).resolve().parents[1])
            try:
                deadline = time.monotonic() + 10
                result = None
                while time.monotonic() < deadline:
                    try:
                        request = urllib.request.Request(f"http://127.0.0.1:{port}/api/field/status",
                                                         headers={"Authorization": f"Bearer {TOKEN}"})
                        with urllib.request.urlopen(request, timeout=1) as response:
                            result = json.load(response)
                        break
                    except urllib.error.URLError:
                        if process.poll() is not None:
                            break
                        time.sleep(0.05)
                self.assertIsNotNone(result, "loopback-only idle service did not become ready")
                self.assertEqual(result["state"], "idle")
                self.assertFalse(result["receiver"]["running"])
                from websockets.sync.client import connect
                with connect(f"ws://127.0.0.1:{port}/ws/field", subprotocols=["blade", TOKEN], proxy=None) as stream:
                    self.assertEqual(stream.subprotocol, "blade")
                    self.assertEqual(json.loads(stream.recv(timeout=2))["waveform"]["values"], [])
            finally:
                process.terminate()
                process.communicate(timeout=10)


if __name__ == "__main__":
    unittest.main()
