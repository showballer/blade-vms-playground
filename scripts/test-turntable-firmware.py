"""Run vendor host regressions plus platform SDK frames against a supplied source.

Only temporary host executables are built. This script never flashes firmware,
connects to a network/serial port, or changes the supplied vendor source tree.
"""
import argparse
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "services/acquisition"))
from blade_acquisition.turntable_driver.protocol import (  # noqa: E402
    CMD_STOP, CMD_CONFIG_GUARD, build_request, build_move_output_tracked, build_axis1_limit_config,
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("firmware", type=Path, help="Path to the matching LightCheck firmware source")
    parser.add_argument("--cc", default=shutil.which("cc") or shutil.which("gcc"))
    args = parser.parse_args()
    root = args.firmware.resolve(strict=True)
    if not args.cc:
        parser.error("A host C compiler (cc/gcc) is required")
    common = [root / "Communication/Src" / (name + ".c") for name in
              ("command_manager", "axis_motion", "limit_switch", "axis_guard", "axis_guard_controller", "trajectory")]
    protocol = [root / "Communication/Src" / (name + ".c") for name in ("pc_protocol", "crc16")]
    lwip = root / "Middlewares/Third_Party/LwIP/src"
    network = sorted((lwip / "core").glob("*.c")) + sorted((lwip / "core/ipv4").glob("*.c"))
    network += [lwip / "netif/ethernet.c", *protocol]
    cases = [(name, root / "tests" / ("test_" + name + ".c"), common, [])
             for name in ("stop", "position_execution", "point_tracking", "guard", "dual_limits", "trajectory")]
    cases += [
        ("no_limits", root / "tests/test_limits.c", common, []),
        ("legacy_limits", root / "tests/test_limits.c", common, ["-DMOTOR_LIMITS_ENABLED=1"]),
        ("network", root / "tests/test_network.c", network, []),
        ("trajectory_protocol", root / "tests/test_trajectory_protocol.c", protocol, []),
        ("axis_motion", root / "tests/test_axis_motion.c", [root / "Communication/Src/axis_motion.c"], []),
        ("limit_debug", root / "tests/test_limit_debug.c", [root / "Communication/Src" / (n + ".c")
                                                          for n in ("limit_debug", "limit_switch")], []),
        ("platform_sdk_frames", REPO / "services/acquisition/tests/firmware/tracked_frames.c", common + protocol, []),
    ]
    with tempfile.TemporaryDirectory(prefix="blade-firmware-") as temporary:
        build = Path(temporary)
        vectors = {"up": build_move_output_tracked(1, .1, 2),
                   "fast_up": build_move_output_tracked(1, 5.06, 3.679),
                   "down": build_move_output_tracked(1, .1, -.2),
                   "stop": build_request(1, CMD_STOP),
                   "clear_execution": build_request(1, CMD_CONFIG_GUARD, parameter=4),
                   "clear_reference": build_axis1_limit_config()}
        (build / "sdk_frames.h").write_text("\n".join(
            "static const uint8_t sdk_%s[] = {%s};" %
            (name, ",".join(str(byte) for byte in frame)) for name, frame in vectors.items()))
        # Darwin libc already supplies byte-order macros; adapt the host port
        # in this temporary directory instead of editing the STM32 port files.
        if sys.platform == "darwin":
            (build / "arch").mkdir()
            port = (root / "Network/Inc/arch/cc.h").read_text()
            (build / "arch/cc.h").write_text(port.replace(
                "#define BYTE_ORDER LITTLE_ENDIAN", "#ifndef BYTE_ORDER\n#define BYTE_ORDER LITTLE_ENDIAN\n#endif"))
        includes = [build] + [root / p for p in ("tests/stubs", "tests", "Communication/Inc", "Network/Inc",
                                               "Middlewares/Third_Party/LwIP/src/include", "Motor_driver/Inc")]
        for name, source, sources, defines in cases:
            binary = build / (name + ".exe")
            command = [args.cc, "-std=c11", "-Wall", "-Wextra", "-Werror", *defines]
            if sys.platform == "darwin" and name == "network":
                command.append("-DLWIP_DONT_PROVIDE_BYTEORDER_FUNCTIONS")
            command += ["-I" + str(path) for path in includes]
            subprocess.run(command + [str(source), *(str(p) for p in sources), "-o", str(binary)],
                           check=True, timeout=90)
            subprocess.run([str(binary)], check=True, timeout=15)
            print("PASS", name, flush=True)
    print(f"Passed {len(cases)} firmware/platform host regressions; no hardware I/O.")


if __name__ == "__main__":
    main()
