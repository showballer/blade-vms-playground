"""Verify a frozen service's new API by rejected requests; never open serial or SDK."""
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request


def check(executable):
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    token = secrets.token_hex(32)
    with tempfile.TemporaryDirectory(prefix="blade-position-api-") as data:
        env = {key: value for key, value in os.environ.items()
               if not key.upper().startswith(("PYTHON", "CONDA")) and key.upper() != "VIRTUAL_ENV"}
        env.update(BLADE_SERVICE_PORT=str(port), BLADE_SERVICE_TOKEN=token,
                   BLADE_DATA_DIR=data, BLADE_POLYTEC_DLL=str(executable.parent / "vendor/DeviceCommunication.dll"))
        process = subprocess.Popen([str(executable)], env=env, cwd=executable.parent,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        try:
            def request(route, body=None):
                req = urllib.request.Request(f"http://127.0.0.1:{port}/api/field/{route}",
                                             data=json.dumps(body).encode() if body is not None else None,
                                             headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
                try:
                    with urllib.request.urlopen(req, timeout=2) as response:
                        return response.status, json.load(response)
                except urllib.error.HTTPError as error:
                    return error.code, json.load(error)

            deadline = time.monotonic() + 25
            while True:
                try:
                    status, value = request("status")
                    assert status == 200 and value["state"] == "idle"
                    break
                except (OSError, AssertionError):
                    if process.poll() is not None or time.monotonic() > deadline:
                        raise RuntimeError("Frozen service did not become ready")
                    time.sleep(0.1)
            checks = ["frozen service starts idle"]
            for action in ("reference", "limits"):
                status, value = request("turntable", {"port": "COM6", "axis": 2, "action": action})
                assert status == 422 and isinstance(value["detail"], str), value
                checks.append(f"new {action} action recognized; rejected before I/O without confirmation")
            base = dict(port="COM6", axis=1, protocol="position", action="prepare", targetAngleDeg=10)
            status, value = request("turntable", base)
            assert status == 422 and isinstance(value["detail"], str), value
            checks.append("position mode recognized; no-confirmation request rejected before I/O")
            status, value = request("turntable", {**base, "action": "manual_move"})
            assert status == 422 and isinstance(value["detail"], str), value
            checks.append("manual_move recognized; rejected before I/O without confirmation")
            recall = {"port": "COM6", "axis": 1, "action": "recall", "axis1AngleDeg": 25.935, "axis2AngleDeg": -6.994}
            status, value = request("turntable", recall)
            assert status == 422 and isinstance(value["detail"], str), value
            checks.append("recall recognized; rejected before I/O without confirmation")
            status, value = request("turntable", {**recall, "axis1AngleDeg": 36.7, "confirmMotion": True})
            assert status == 422 and isinstance(value["detail"], list), value
            checks.append("recall rejects historical axis1 angle above 35 degrees before I/O")
            for axis, angle in ((1, 35.001), (2, -180.001)):
                status, value = request("turntable", {**base, "axis": axis, "targetAngleDeg": angle, "confirmMotion": True})
                assert status == 422 and isinstance(value["detail"], list), value
                checks.append(f"axis {axis} target bounds enforced in frozen application")
            return {"passed": True, "hardwareTouched": False, "executable": str(executable), "checks": checks}
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


if __name__ == "__main__":
    print(json.dumps(check(Path(sys.argv[1]).resolve()), ensure_ascii=False, indent=2))
