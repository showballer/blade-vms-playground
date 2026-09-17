# Build on Windows x64. Vendor binaries are supplied separately after licensing review.
from pathlib import Path
from PyInstaller.utils.hooks import collect_submodules

root = Path(SPECPATH)
a = Analysis(
    [str(root / "launch_service.py")], pathex=[str(root)], binaries=[], datas=[],
    hiddenimports=collect_submodules("uvicorn") + collect_submodules("websockets") +
        ["blade_acquisition.analysis", "blade_acquisition.rotation", "numpy", "scipy"],
    hookspath=[], hooksconfig={}, runtime_hooks=[], excludes=[], noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="BladeAcquisition",
          debug=False, bootloader_ignore_signals=False, strip=False, upx=False,
          console=True, disable_windowed_traceback=False)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="BladeAcquisition")
