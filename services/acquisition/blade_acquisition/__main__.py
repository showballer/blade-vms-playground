from __future__ import annotations

import multiprocessing

from .service import Settings, create_app


def main() -> None:
    import uvicorn

    settings = Settings.from_environment()
    uvicorn.run(create_app(settings), host="127.0.0.1", port=settings.port,
                workers=1, reload=False, access_log=False, server_header=False,
                proxy_headers=False, loop="asyncio", http="h11", ws="websockets",
                timeout_graceful_shutdown=25, log_level="info")


if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
