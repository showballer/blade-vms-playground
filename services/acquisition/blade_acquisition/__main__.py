from __future__ import annotations

import multiprocessing
import json
import os
import sys
from pathlib import Path

from .service import Settings, create_app


def self_check() -> dict:
    """Bind the shipped SDK only; never open a connection or invoke any SDK function."""
    from .receiver import ReceiverConfig
    from .device import DevicePanel

    base = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parents[1]
    dll = Path(os.environ.get("BLADE_POLYTEC_DLL") or base / "vendor" / "DeviceCommunication.dll").resolve()
    receiver = DevicePanel(ReceiverConfig("", "", str(dll)))
    try:
        api = receiver._load_api()
        return {"frozen": bool(getattr(sys, "frozen", False)), "executable": sys.executable,
                "pythonVersion": sys.version.split()[0], "runtimePrefix": sys.prefix,
                "dllPath": str(dll), "dllLoaded": True,
                "sdkSymbols": sum(name.startswith("Poly") for name in vars(api)),
                "sdkSymbolNames": sorted(name for name in vars(api) if name.startswith("Poly")),
                "hardwareTouched": False}
    finally:
        if receiver._dll_directory is not None:
            receiver._dll_directory.close()


def main() -> None:
    if sys.argv[1:] == ["--self-check"]:
        try:
            print(json.dumps(self_check(), ensure_ascii=True))
        except Exception as exc:
            print(json.dumps({"dllLoaded": False, "hardwareTouched": False, "error": str(exc)}, ensure_ascii=True))
            raise SystemExit(1) from exc
        return
    if sys.argv[1:]:
        raise SystemExit("Usage: BladeAcquisition.exe [--self-check]")
    import uvicorn

    settings = Settings.from_environment()
    uvicorn.run(create_app(settings), host="127.0.0.1", port=settings.port,
                workers=1, reload=False, access_log=False, server_header=False,
                proxy_headers=False, loop="asyncio", http="h11", ws="websockets",
                timeout_graceful_shutdown=25, log_level="info")


if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
