"""Six explicitly synthetic, common-phase 20 Hz records for the desktop smoke test."""
import json
import sys
from pathlib import Path

import numpy as np
from blade_acquisition.receiver import Batch
from blade_acquisition.storage import RecordingStore


def create(root):
    store = RecordingStore(root / "recordings")
    positions = [.15, .3, .5, .7, .85, 1.0]
    # Independent explicit mode-2 formula rather than calling the matcher.
    beta = 4.694091132974175
    sigma = (np.cosh(beta) + np.cos(beta)) / (np.sinh(beta) + np.sin(beta))
    def shape(x):
        return np.cosh(beta*x) - np.cos(beta*x) - sigma * (np.sinh(beta*x) - np.sin(beta*x))
    ids = []
    for i, x in enumerate(positions):
        amplitude = .002 * shape(x) / shape(1)
        writer = store.create({"name": f"Simulation P{i+1}", "source": "simulation", "point": f"P{i+1}",
                               "truth": {"mode": 2, "xOverL": x, "rpm": 600, "frequencyHz": 20,
                                         "velocityAmplitudeMps": float(amplitude), "commonPhaseRad": .4, "seed": None}})
        writer.ready(1000, 1700000000)
        t = np.arange(5000) / 1000
        values = amplitude * np.sin(2*np.pi*20*t + .4)
        writer.write(Batch(0, 1000, 1700000000, [0]*5000, values.tolist(), [400]*5000, [80.]*5000, [False]*5000))
        writer.finish(None)
        ids.append(writer.id)
    return {"recordingIds": ids, "positions": positions}


if __name__ == "__main__":
    print(json.dumps(create(Path(sys.argv[1]))))
