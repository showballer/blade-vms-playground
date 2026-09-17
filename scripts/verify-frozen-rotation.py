"""Smoke-test a packaged service with isolated synthetic records, no hardware."""
import hashlib
import json
import math
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services" / "acquisition"))
from blade_acquisition.storage import RecordingStore
from blade_acquisition.receiver import Batch
sys.path.insert(0, str(ROOT / "services" / "acquisition" / "tests"))
from create_bending_fixture import create as create_bending_fixture


def main():
    executable = Path(sys.argv[1]).resolve()
    assert executable.is_file()
    with tempfile.TemporaryDirectory(prefix="blade-frozen-rotation-") as directory:
        store = RecordingStore(Path(directory) / "recordings")
        ids = []
        for rate, amplitude, phase in [(1000, .2, 0), (800, .1, math.pi / 2)]:
            count = rate * 3
            values = [amplitude * math.sin(2 * math.pi * 20 * i / rate + phase) for i in range(count)]
            writer = store.create({"name": "isolated simulation", "source": "simulation"})
            writer.ready(rate, 1700000000)
            writer.write(Batch(0, rate, 1700000000, [0]*count, values, [100]*count, [80.]*count, [False]*count))
            writer.finish(None)
            ids.append(writer.id)
        bending_input = create_bending_fixture(Path(directory))
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        token = secrets.token_hex(32)
        environment = {**os.environ, "BLADE_DATA_DIR": directory, "BLADE_SERVICE_TOKEN": token,
                       "BLADE_SERVICE_PORT": str(port)}
        for key in list(environment):
            if key.upper().startswith(("PYTHON", "CONDA", "VIRTUAL_ENV")):
                environment.pop(key)
        with open(Path(directory) / "service.log", "w+b") as log:
            process = subprocess.Popen([str(executable)], env=environment, stdout=log, stderr=log,
                                       creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            try:
                def request(route, data=None):
                    payload = None if data is None else json.dumps(data).encode()
                    req = urllib.request.Request(f"http://127.0.0.1:{port}/api/field/{route}", data=payload,
                          headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
                    with urllib.request.urlopen(req, timeout=10) as response:
                        return json.load(response)
                deadline = time.monotonic() + 45
                while True:
                    try:
                        assert request("status")["state"] == "idle"
                        break
                    except (OSError, AssertionError):
                        if process.poll() is not None or time.monotonic() > deadline:
                            log.seek(0)
                            raise RuntimeError(log.read().decode(errors="replace"))
                        time.sleep(.2)
                result = request("rotation", {"recordingIds": ids, "rpm": 600, "pointsPerRevolution": 128,
                                 "targetOrder": 2, "maxOrder": 5, "maxRevolutions": 20, "positions": [.2, .8]})
                spectrum = result["orderSpectra"][0]
                peak = max(range(len(spectrum["orders"])), key=lambda i: spectrum["amplitudes"][i])
                points = result["modeShape"]["points"]
                assert abs(spectrum["orders"][peak] - 2) < .01
                assert abs(points[0]["amplitude"] - .2) < .01
                assert abs(points[1]["relativePhaseDeg"] - 90) < 2
                bending = request("rotation", {**bending_input, "rpm": 600, "targetOrder": 2,
                                               "pointsPerRevolution": 128, "maxOrder": 5})
                match = bending["modalMatch"]
                assert match["candidateMode"] == 2
                assert match["pointNames"] == [f"P{i+1}" for i in range(6)]
                assert match["candidates"][1]["mac"] > .99999
                assert len(match["candidates"]) == 4
                assert request("status")["receiver"]["running"] is False
                print(json.dumps({"passed": True, "executable": str(executable),
                      "serviceSha256": hashlib.sha256(executable.read_bytes()).hexdigest(),
                      "algorithmVersion": result["algorithmVersion"], "peakOrder": spectrum["orders"][peak],
                      "relativePhaseDeg": points[1]["relativePhaseDeg"], "candidateMode": match["candidateMode"],
                      "mode2Mac": match["candidates"][1]["mac"], "hardwareTouched": False}))
            finally:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)


if __name__ == "__main__":
    main()
