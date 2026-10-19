#!/usr/bin/env python3
"""Build the supplied Polytec SDK for Apple Silicon; never access devices or install tools."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

TOOLS = Path(__file__).resolve().parent
REPOSITORY = TOOLS.parent.parent
SDK_ITEMS = ("src", "include", "examples", "CMakeLists.txt", "README.md", "LICENSE.md", "LICENSE.LESSER.md")
LIBRARY = "libDeviceCommunication.dylib"


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(arguments: list[str], **kwargs) -> str:
    return subprocess.check_output(arguments, text=True, stderr=subprocess.STDOUT, **kwargs)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sdk", required=True, type=Path, help="Original vendor SDK directory (not modified)")
    parser.add_argument("--output", type=Path, default=REPOSITORY / "apps/desktop/resources/acquisition/vendor")
    parser.add_argument("--work-dir", type=Path, help="New build directory; default is an ignored artifacts directory")
    parser.add_argument("--boost-prefix", type=Path, help="Installed Boost prefix; otherwise use brew --prefix boost")
    parser.add_argument("--replace", action="store_true", help="Replace this build's named output files; keep other files")
    args = parser.parse_args()
    if sys.platform != "darwin" or platform.machine() != "arm64":
        parser.error("This build is currently verified only on native Apple Silicon macOS (arm64 Python).")
    required = ("cmake", "xcrun", "patch", "otool", "file")
    missing = [name for name in required if not shutil.which(name)]
    if missing:
        parser.error(f"Missing tools: {', '.join(missing)}. Install Xcode command-line tools and CMake first; this script installs nothing.")
    run(["xcrun", "--find", "clang++"])
    sdk, output = args.sdk.expanduser().resolve(), args.output.expanduser().resolve()
    for name in SDK_ITEMS:
        if not (sdk / name).exists():
            parser.error(f"Incomplete SDK: {sdk / name}")
    if output == sdk or sdk in output.parents:
        parser.error("Output must be outside the original SDK directory.")
    boost = args.boost_prefix
    if boost is None and shutil.which("brew"):
        try:
            boost = Path(run(["brew", "--prefix", "boost"]).strip())
        except subprocess.CalledProcessError:
            pass
    if boost is None or not (boost.expanduser() / "include/boost/version.hpp").is_file():
        parser.error("Boost headers were not found. Install Boost separately, or pass --boost-prefix. No dependencies were installed.")
    boost = boost.expanduser().resolve()
    version_text = (boost / "include/boost/version.hpp").read_text()
    boost_version = re.search(r'#define BOOST_LIB_VERSION "([^"]+)"', version_text).group(1)
    destinations = [output / LIBRARY, output / "polytec-macos-build.json", output / "licenses/polytec-macos", output / "source/polytec-macos"]
    if not args.replace and any(path.exists() for path in destinations):
        parser.error("A macOS SDK output already exists. Choose another --output or explicitly pass --replace.")
    if args.work_dir:
        work = args.work_dir.expanduser().resolve()
        if work == sdk or sdk in work.parents:
            parser.error("Build directory must be outside the original SDK directory.")
        work.mkdir(parents=True, exist_ok=False)
    else:
        parent = REPOSITORY / "artifacts"
        parent.mkdir(exist_ok=True)
        work = Path(tempfile.mkdtemp(prefix="polytec-macos-", dir=parent))
    original, source, build = work / "original", work / "source", work / "build"
    original.mkdir()
    for name in SDK_ITEMS:
        if (sdk / name).is_dir():
            shutil.copytree(sdk / name, original / name)
        else:
            shutil.copy2(sdk / name, original / name)
    shutil.copytree(original, source)
    patch = TOOLS / "macos-compat.patch"
    # Vendor Windows sources use CRLF. Normalize only files named by our patch.
    for relative in re.findall(r'^\+\+\+ b/(.+)$', patch.read_text(), re.MULTILINE):
        target = source / relative
        if source not in target.resolve().parents:
            raise ValueError("Invalid patch path")
        target.write_text(target.read_text())
    commands = [
        ["patch", "-p1", "--batch", "--forward", "-i", str(patch)],
        ["cmake", "-S", str(source), "-B", str(build), "-DCMAKE_BUILD_TYPE=Release",
         "-DCMAKE_OSX_ARCHITECTURES=arm64", "-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0",
         "-DCMAKE_POLICY_VERSION_MINIMUM=3.5", "-DBUILD_EXAMPLES=OFF", "-DBUILD_DEVICE_PANEL=OFF",
         "-DBoost_USE_STATIC_LIBS=ON", f"-DBoost_ROOT={boost}"],
        ["cmake", "--build", str(build), "--target", "DeviceCommunication", "--parallel", "8"],
    ]
    print(f"Building SDK in {work}; original source is unchanged.", flush=True)
    for number, command in enumerate(commands, 1):
        log = work / f"{number}-build.log"
        with log.open("w") as stream:
            subprocess.run(command, cwd=source, stdout=stream, stderr=subprocess.STDOUT, check=True)
    library = build / "src" / LIBRARY
    smoke = run([sys.executable, str(TOOLS / "smoke.py"), "--library", str(library), "--headers", str(source / "include")])
    (work / "smoke-report.json").write_text(smoke)
    linked = run(["otool", "-L", str(library)])
    # Distributable dylib must not retain a dependency on this machine's Homebrew prefix.
    for line in linked.splitlines()[2:]:
        dependency = line.strip().split(" ", 1)[0]
        if dependency and not dependency.startswith(("/usr/lib/", "/System/Library/")):
            raise RuntimeError(f"Unexpected non-system dynamic dependency: {dependency}")
    report = {
        "builtAt": datetime.now(timezone.utc).isoformat(), "platform": "darwin-arm64", "minimumMacOS": "12.0",
        "librarySha256": digest(library), "sdkSource": str(sdk), "patchSha256": digest(patch),
        "boostVersion": boost_version, "cmake": run(["cmake", "--version"]).splitlines()[0],
        "compiler": run(["xcrun", "clang++", "--version"]).splitlines()[0],
        "dynamicDependencies": linked.splitlines()[1:], "smoke": json.loads(smoke), "hardwareAccessed": False,
    }
    stage = work / "bundle"
    licenses, materials = stage / "licenses/polytec-macos", stage / "source/polytec-macos"
    licenses.mkdir(parents=True)
    materials.mkdir(parents=True)
    shutil.copy2(library, stage / LIBRARY)
    for name in ("LICENSE.md", "LICENSE.LESSER.md"):
        shutil.copy2(original / name, licenses / name)
    for name in ("BOOST-LICENSE-1.0.txt", "GSL-MIT-LICENSE.txt"):
        shutil.copy2(TOOLS / "licenses" / name, licenses / name)
    shutil.copy2(TOOLS / "NOTICE.md", licenses / "NOTICE.md")
    # The archive is generated only in the chosen output directory, never added to Git.
    with tarfile.open(materials / "DeviceCommunication-original-source.tar.gz", "w:gz") as archive:
        archive.add(original, arcname="DeviceCommunication-original")
    for name in ("build.py", "smoke.py", "macos-compat.patch", "NOTICE.md", "README.md"):
        shutil.copy2(TOOLS / name, materials / name)
    shutil.copytree(TOOLS / "licenses", materials / "licenses")
    report["originalSourceArchiveSha256"] = digest(materials / "DeviceCommunication-original-source.tar.gz")
    (stage / "polytec-macos-build.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    output.mkdir(parents=True, exist_ok=True)
    shutil.copytree(stage, output, dirs_exist_ok=True)
    print(f"PASS: {output / LIBRARY}")
    print(f"SHA-256: {report['librarySha256']}")
    print(f"Logs: {work}\nSource, patch, build scripts and license notices were included. No device was accessed.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, subprocess.CalledProcessError, ValueError, RuntimeError) as exc:
        print(f"Build failed: {exc}", file=sys.stderr)
        sys.exit(1)
