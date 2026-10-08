"""Explicit, paced playback of the supplied static-derived rotating-blade fixture.

This module never imports/loads a device SDK or opens a network socket. Synthetic
scenario modifications are recorded as provenance, not presented as measurements.
"""
from __future__ import annotations

from functools import lru_cache
import gzip
import json
import math
from pathlib import Path
import threading
import time
from typing import Literal

import numpy as np
from pydantic import BaseModel, ConfigDict

from .receiver import Batch

FIXTURE_PATH = Path(__file__).with_name("resources") / "rotation_from_static.json.gz"
SEAM_SECONDS = 0.016
SCENARIOS = [
    {"id": "baseline", "label": "源数据回放", "description": "原工作簿速度与回波信号循环回放；不等同于无缺陷实测。"},
    {"id": "imbalance", "label": "振动增大", "description": "人工放大速度并叠加 20 Hz 分量，用于观察 RMS 与 FFT 变化。"},
    {"id": "impact", "label": "周期冲击", "description": "每 1.3 秒人工叠加短时衰减冲击，用于观察峰值及时频变化。"},
    {"id": "low_return", "label": "低回波", "description": "人工降低 RSSI，用于测试信号质量展示；不代表结构损伤。"},
]


class SimulationConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    point: Literal["P1", "P2", "P3"] = "P1"
    scenario: Literal["baseline", "imbalance", "impact", "low_return"] = "baseline"


@lru_cache(maxsize=1)
def fixture() -> dict:
    with gzip.open(FIXTURE_PATH, "rt", encoding="utf-8") as stream:
        contents = stream.read(4_000_001)
    if len(contents) > 4_000_000:
        raise ValueError("模拟数据资源超出大小限制。")
    value = json.loads(contents)
    if value.get("schemaVersion") != 1 or value.get("unit") != "m/s":
        raise ValueError("模拟数据版本或单位无效。")
    for point in value["points"]:
        count, rate = point["samples"], point["sampleRate"]
        if not 64 <= count <= 100_000 or not math.isfinite(rate) or not 1 <= rate <= 10_000:
            raise ValueError("模拟数据样本数或采样率无效。")
        for name in ("velocity", "rssi", "lowReturn"):
            if len(point[name]) != count:
                raise ValueError("模拟数据通道长度不一致。")
        if not all(math.isfinite(x) for x in point["velocity"] + point["rssi"]):
            raise ValueError("模拟数据包含非有限值。")
        if not all(0 <= x <= 100 for x in point["rssi"]):
            raise ValueError("模拟数据回波百分比无效。")
    return value


def simulation_catalog() -> dict:
    data = fixture()
    return {**{key: data[key] for key in ("sourceFile", "sourceSha256", "sourceScript", "sourceScriptSha256", "notice")},
            "unit": "m/s", "loop": True, "seamSeconds": SEAM_SECONDS,
            "points": [{key: p[key] for key in ("id", "label", "sampleRate", "samples", "durationSeconds", "position")}
                       for p in data["points"]], "scenarios": SCENARIOS}


def smooth_periodic_seam(values: np.ndarray, rate: float) -> np.ndarray:
    """A short cosine bridge around the wrap avoids a synthetic boundary impulse.

    Only the last/first 8 ms are changed; the imported fixture remains untouched.
    The bridge, including its duration, is disclosed in the recording provenance.
    """
    values = values.copy()
    half = min(max(2, round(rate * SEAM_SECONDS / 2)), len(values) // 8)
    indices = np.r_[np.arange(len(values) - half, len(values)), np.arange(half)]
    start, end = values[-half - 1], values[half]
    phase = (np.arange(len(indices)) + 1) / (len(indices) + 1)
    weight = (1 - np.cos(np.pi * phase)) / 2
    values[indices] = start * (1 - weight) + end * weight
    return values


class SimulationReceiver:
    def __init__(self, config: SimulationConfig):
        self.config = config
        self.data = fixture()
        self.point = next(p for p in self.data["points"] if p["id"] == config.point)
        self.sample_rate = self.point["sampleRate"]
        self.velocity = smooth_periodic_seam(np.asarray(self.point["velocity"], dtype=np.float64), self.sample_rate)
        self.rssi = smooth_periodic_seam(np.asarray(self.point["rssi"], dtype=np.float64), self.sample_rate)
        self.rms = float(np.sqrt(np.mean(self.velocity ** 2)))
        self.velocity_range_mps = 2.0
        self.device_settings = None

    def validate(self) -> None:
        # Construction validates the packaged fixture. No platform/SDK fallback.
        return None

    def provenance(self) -> dict:
        scenario = next(item for item in SCENARIOS if item["id"] == self.config.scenario)
        return {**self.config.model_dump(), "label": self.point["label"], "scenarioLabel": scenario["label"],
                "scenarioDescription": scenario["description"], "synthetic": True,
                "injected": self.config.scenario != "baseline", "loop": True,
                "loopSamples": len(self.velocity), "loopDurationSeconds": len(self.velocity) / self.sample_rate,
                "seamSeconds": SEAM_SECONDS, "seamProcessing": "16 ms cosine bridge across each loop boundary",
                "unit": "m/s", "sampleRate": self.sample_rate, "rpm": self.data["rpm"],
                "position": self.point["position"],
                "sourceFile": self.data["sourceFile"], "sourceSheet": self.point["sheet"],
                "sourceSha256": self.data["sourceSha256"], "sourceScript": self.data["sourceScript"],
                "sourceScriptSha256": self.data["sourceScriptSha256"],
                "rawEncoding": "synthetic velocity_m_s * 1000000 rounded; RSSI_percent * 1000 rounded",
                "notice": self.data["notice"]}

    def batch(self, start: int, count: int, origin: float) -> Batch:
        indices = np.arange(start, start + count, dtype=np.int64)
        phase = indices % len(self.velocity)
        seconds = indices / self.sample_rate
        velocity = self.velocity[phase].copy()
        rssi = self.rssi[phase].copy()
        if self.config.scenario == "imbalance":
            velocity = 1.8 * velocity + self.rms * 1.5 * np.sin(2 * np.pi * (self.data["rpm"] / 60) * seconds)
        elif self.config.scenario == "impact":
            pulse_age = np.remainder(seconds + 0.1, 1.3)
            # Pulse frequency stays below Nyquist for every supplied measurement point.
            velocity += self.rms * 8 * np.exp(-pulse_age / 0.045) * np.sin(2 * np.pi * 140 * pulse_age)
        elif self.config.scenario == "low_return":
            rssi *= 0.12
        return Batch(start, self.sample_rate, origin, np.rint(velocity * 1_000_000).astype(np.int32).tolist(),
                     velocity.tolist(), np.rint(rssi * 1000).astype(np.int32).tolist(), rssi.tolist(),
                     (np.abs(velocity) > self.velocity_range_mps).tolist())

    def run(self, stop: threading.Event, ready, receive) -> None:
        if stop.is_set():
            return
        origin, clock_start = time.time(), time.monotonic()
        ready(self.sample_rate, origin)
        start, batch_size = 0, max(1, round(self.sample_rate * 0.05))
        while not stop.is_set():
            # The monotonic target is tied to sample index, not the last callback.
            # Stop interrupts this wait immediately; no subprocess or Timer survives.
            deadline = clock_start + (start + batch_size) / self.sample_rate
            if stop.wait(max(0.0, deadline - time.monotonic())):
                break
            receive(self.batch(start, batch_size, origin))
            start += batch_size
