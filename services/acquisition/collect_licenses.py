"""Build-time attribution inventory; these files are shipped with the frozen service."""
from importlib import metadata
import json
from pathlib import Path
import shutil
import sys
import sysconfig


def collect(destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    python_license = Path(sys.base_prefix) / "LICENSE.txt"
    if not python_license.is_file():
        python_license = Path(sysconfig.get_path("stdlib")) / "LICENSE.txt"
    if not python_license.is_file():
        raise FileNotFoundError(f"Python distribution license is missing: {python_license}")
    shutil.copy2(python_license, destination / "Python-LICENSE.txt")
    inventory = []
    for distribution in sorted(metadata.distributions(), key=lambda item: item.metadata["Name"].lower()):
        name = distribution.metadata["Name"]
        safe_name = "".join(character if character.isalnum() or character in "-_." else "_" for character in name)
        target = destination / f"{safe_name}-{distribution.version}"
        target.mkdir(exist_ok=True)
        (target / "METADATA.txt").write_text(distribution.read_text("METADATA") or "", encoding="utf-8")
        copied = []
        # pyserial 3.5's wheel omits the upstream license; ship the exact v3.5 text.
        if name.lower() == "pyserial":
            license_file = Path(__file__).resolve().parent / "licenses" / "pyserial-LICENSE.txt"
            shutil.copy2(license_file, target / "LICENSE.txt")
            copied.append("LICENSE.txt")
        for entry in distribution.files or []:
            if not any(word in str(entry).lower() for word in ("license", "copying", "notice")):
                continue
            if ".." in entry.parts or entry.is_absolute():
                continue
            source = Path(distribution.locate_file(entry))
            if source.is_file():
                output = target / str(entry)
                output.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, output)
                copied.append(str(entry))
        inventory.append({"name": name, "version": distribution.version, "licenseFiles": copied})
    (destination / "inventory.json").write_text(json.dumps({"python": sys.version, "packages": inventory}, indent=2), encoding="utf-8")


if __name__ == "__main__":
    collect(Path(sys.argv[1]))
