# Build on the target OS/architecture. Vendor binaries are supplied separately.
from pathlib import Path
import sys
from PyInstaller.utils.hooks import collect_submodules

root = Path(SPECPATH)
a = Analysis(
    [str(root / "launch_service.py")], pathex=[str(root)], binaries=[],
    datas=[(str(root / "blade_acquisition" / "resources" / "rotation_from_static.json.gz"), "blade_acquisition/resources")],
    hiddenimports=collect_submodules("uvicorn") + collect_submodules("websockets") +
        ["blade_acquisition.analysis", "blade_acquisition.rotation", "blade_acquisition.simulation",
         "blade_acquisition.csv_export", "blade_acquisition.task_export", "blade_acquisition.upload_sampling", "blade_acquisition.drive_position", "serial", "serial.tools.list_ports", "numpy", "scipy"] +
        (["serial.win32", "serial.serialwin32"] if sys.platform == "win32" else ["serial.serialposix"]),
    hookspath=[], hooksconfig={}, runtime_hooks=[], excludes=[], noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="BladeAcquisition",
          debug=False, bootloader_ignore_signals=False, strip=False, upx=False,
          console=True, disable_windowed_traceback=False)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="BladeAcquisition")
