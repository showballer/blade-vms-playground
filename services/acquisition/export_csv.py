"""Stream a raw recording to CSV; standard library only, no network or hardware."""
from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

from blade_acquisition.storage import HEADER, MAGIC, RECORD, CHUNK_PATTERN, ID_PATTERN


def export(recording_directory: Path, output: Path) -> int:
    directory = recording_directory.resolve(strict=True)
    if not ID_PATTERN.fullmatch(directory.name):
        raise ValueError("Expected a service-created recording UUID directory.")
    manifest_path = directory / "manifest.json"
    if manifest_path.is_symlink():
        raise ValueError("Manifest symlinks are not accepted.")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("id") != directory.name:
        raise ValueError("Recording manifest ID mismatch.")
    if manifest.get("status") == "incomplete" and not manifest.get("recovered"):
        raise ValueError("Recording may still be active. Stop acquisition first, or restart the service to recover an interrupted recording.")
    count = 0
    # Exclusive create is intentional: never overwrite the user's existing export.
    with output.open("x", encoding="utf-8-sig", newline="") as target:
        writer = csv.writer(target)
        writer.writerow(["sample", "time_s", "velocity_raw", "velocity_m_s", "overrange", "rssi_raw", "rssi_percent"])
        paths = sorted(path for path in directory.iterdir() if CHUNK_PATTERN.fullmatch(path.name)
                       and path.is_file() and not path.is_symlink())
        for path in paths:
            with path.open("rb") as source:
                magic, rate, origin, sample_start = HEADER.unpack(source.read(HEADER.size))
                if magic != MAGIC or rate <= 0 or sample_start != count:
                    raise ValueError(f"Invalid/non-contiguous chunk: {path.name}; partial CSV retained.")
                while True:
                    data = source.read(RECORD.size * 8192)
                    if not data:
                        break
                    complete_length = len(data) // RECORD.size * RECORD.size
                    for index, raw, velocity, rssi_raw, rssi, flags in RECORD.iter_unpack(data[:complete_length]):
                        if index != count:
                            raise ValueError("Non-contiguous sample index; partial CSV retained.")
                        writer.writerow([index, format(index / rate, ".12g"), raw, format(velocity, ".12g"),
                                         int(bool(flags & 1)), rssi_raw if flags & 2 else "",
                                         format(rssi, ".9g") if flags & 2 else ""])
                        count += 1
                    if complete_length != len(data) and manifest.get("status") == "complete":
                        raise ValueError("Unexpected partial raw record; partial CSV retained.")
    return count


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("recording_directory", type=Path)
    parser.add_argument("output_csv", type=Path)
    arguments = parser.parse_args()
    print(f"Exported {export(arguments.recording_directory, arguments.output_csv)} samples to {arguments.output_csv}")


if __name__ == "__main__":
    main()
