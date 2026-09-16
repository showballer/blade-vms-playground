"""Explicit offline sine fixture for the isolated desktop analysis validation UI."""
import sys
from pathlib import Path

import numpy as np
from blade_acquisition.storage import RecordingStore
from blade_acquisition.receiver import Batch


def create(root):
    store = RecordingStore(root / "recordings")
    writer = store.create({"name": "仿真验证 · 32Hz + 128Hz", "source": "simulation", "object": "已知正弦", "point": "CH1",
                           "truth": {"frequenciesHz": [32, 128], "amplitudesMps": [0.2, 0.05], "seed": None}})
    writer.ready(2048, 1700000000)
    for start in range(0, 16384, 2048):
        t = np.arange(start, start + 2048) / 2048
        x = 0.2 * np.sin(2 * np.pi * 32 * t) + 0.05 * np.sin(2 * np.pi * 128 * t)
        writer.write(Batch(start, 2048, 1700000000, [0] * 2048, x.tolist(), [400] * 2048, [80.] * 2048, [False] * 2048))
    writer.finish(None)
    print(writer.id)


if __name__ == "__main__":
    create(Path(sys.argv[1]))
