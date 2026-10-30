"""Runtime measurement inputs and fixed-station vector geometry; SI units only."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
import math
from typing import Any, Mapping

import numpy as np


class SignalError(ValueError):
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(f"{code}: {message}")


def number(value: Any, name: str, *, positive: bool = False) -> float | None:
    if value is None:
        return None
    if isinstance(value, (bool, str)):
        raise SignalError("INVALID_MEASUREMENT_INPUT", f"{name} must be a numeric value in SI units")
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise SignalError("INVALID_MEASUREMENT_INPUT", f"{name} requires a numeric scalar") from exc
    if not math.isfinite(result) or (positive and result <= 0):
        raise SignalError("INVALID_MEASUREMENT_INPUT", f"invalid {name}: {value!r}")
    return result


def vector(value: Any, name: str) -> tuple[float, float, float] | None:
    if value is None:
        return None
    if not isinstance(value, (tuple, list, np.ndarray)) or np.ndim(value) != 1 or len(value) != 3:
        raise SignalError("INVALID_MEASUREMENT_INPUT", f"{name} requires three coordinates")
    values = tuple(number(v, name) for v in value)
    if any(v is None for v in values):
        raise SignalError("INVALID_MEASUREMENT_INPUT", f"{name} contains missing coordinates")
    return values  # type: ignore[return-value]


@dataclass(frozen=True)
class MeasurementInputs:
    horizontal_distance_m: float | None = None
    hub_height_delta_m: float | None = None
    hub_height_m: float | None = None
    laser_height_m: float | None = None
    blade_length_m: float | None = None
    radius_from_hub_m: float | None = None
    distance_from_root_m: float | None = None
    root_radius_m: float | None = None
    azimuth_deg: float | None = None
    lateral_offset_m: float | None = None
    laser_position_world_m: tuple[float, float, float] | None = None
    hub_position_world_m: tuple[float, float, float] | None = None
    station_position_world_m: tuple[float, float, float] | None = None
    shaft_axis_world: tuple[float, float, float] | None = None
    source: dict[str, str] = field(default_factory=dict)

    def snapshot(self) -> dict[str, Any]:
        return asdict(self)


def read_measurement_inputs(
    manifest: Mapping[str, Any],
    measurement_inputs: Mapping[str, Any] | None = None,
) -> MeasurementInputs:
    """Read current form values, otherwise the saved per-record measurement snapshot.

    Only existing, verified field paths are adapted. Never read turntable RPM as rotor RPM.
    Omitted override keys use the recorded snapshot; explicit null means unknown.
    Absolute hub/laser heights are optional if the existing form already saved their delta.
    """
    pc = manifest.get("pointCycle") or {}
    g = ((manifest.get("turntable") or {}).get("config") or {}).get("geometry") or {}
    supplied = dict(measurement_inputs or {})
    fields = set(MeasurementInputs.__dataclass_fields__) - {"source"}
    unknown = set(supplied) - fields
    if unknown:
        raise SignalError("UNKNOWN_MEASUREMENT_FIELD", ", ".join(sorted(unknown)))
    saved = {
        "horizontal_distance_m": (g.get("distanceM"), "manifest.turntable.config.geometry.distanceM"),
        "hub_height_delta_m": (g.get("hubHeightDeltaM"), "manifest.turntable.config.geometry.hubHeightDeltaM"),
        "blade_length_m": (pc.get("bladeLengthM"), "manifest.pointCycle.bladeLengthM"),
        "radius_from_hub_m": (pc.get("radiusM"), "manifest.pointCycle.radiusM"),
        "root_radius_m": (pc.get("rootRadiusM"), "manifest.pointCycle.rootRadiusM"),
        "distance_from_root_m": (pc.get("distanceFromRootM"), "manifest.pointCycle.distanceFromRootM"),
        "azimuth_deg": (pc.get("azimuthDeg"), "manifest.pointCycle.azimuthDeg"),
    }
    values: dict[str, Any] = {}
    sources: dict[str, str] = {}
    positive = {"horizontal_distance_m", "blade_length_m"}
    vectors = {"laser_position_world_m", "hub_position_world_m", "station_position_world_m", "shaft_axis_world"}
    for key in fields:
        if key in supplied:
            value, provenance = supplied[key], f"measurement_inputs.{key}"
        else:
            value, provenance = saved.get(key, (None, "missing"))
        values[key] = vector(value, key) if key in vectors else number(value, key, positive=key in positive)
        sources[key] = provenance
    # A fresh pair of heights takes precedence over an older recorded height difference.
    if "hub_height_m" in supplied and "laser_height_m" in supplied:
        H, h = values["hub_height_m"], values["laser_height_m"]
        if H is not None and h is not None:
            delta = H - h
            if "hub_height_delta_m" in supplied and values["hub_height_delta_m"] is not None:
                if not math.isclose(values["hub_height_delta_m"], delta, abs_tol=1e-9, rel_tol=1e-9):
                    raise SignalError("MEASUREMENT_INPUT_CONFLICT", "height difference disagrees with current heights")
            values["hub_height_delta_m"] = delta
            sources["hub_height_delta_m"] = "derived:current_hub_height-current_laser_height"
    # Recompute radius only when the caller explicitly supplies both constituent inputs.
    if "radius_from_hub_m" not in supplied and {"root_radius_m", "distance_from_root_m"} <= supplied.keys():
        root, distance = values["root_radius_m"], values["distance_from_root_m"]
        values["radius_from_hub_m"] = None if root is None or distance is None else root + distance
        sources["radius_from_hub_m"] = "derived:current_root_radius+current_distance_from_root"
    if values["radius_from_hub_m"] is None and "radius_from_hub_m" not in supplied:
        root, distance = values["root_radius_m"], values["distance_from_root_m"]
        if root is not None and distance is not None:
            values["radius_from_hub_m"] = root + distance
            sources["radius_from_hub_m"] = "derived:recorded_root_radius+recorded_distance_from_root"
    for key in ("radius_from_hub_m", "root_radius_m", "distance_from_root_m"):
        if values[key] is not None and values[key] < 0:
            raise SignalError("INVALID_MEASUREMENT_INPUT", f"{key} cannot be negative")
    return MeasurementInputs(**values, source=sources)


@dataclass(frozen=True)
class GeometryResult:
    los_unit: tuple[float, float, float]
    axial_unit: tuple[float, float, float]
    radius_vector_m: tuple[float, float, float]
    axial_projection: float
    radial_projection: float
    tangential_projection: float
    rotational_los_per_rad_s_m: float
    slant_distance_m: float
    model: str
    assumptions: tuple[str, ...]
    measurement_inputs: dict[str, Any]

    @property
    def gain(self) -> float | None:
        return None if abs(self.axial_projection) < 1e-12 else abs(1 / self.axial_projection)

    def snapshot(self) -> dict[str, Any]:
        result = asdict(self)
        result["projection_gain"] = self.gain
        ka = self.axial_projection
        result["radial_over_axial"] = self.radial_projection / ka if self.gain is not None else None
        result["tangential_over_axial"] = self.tangential_projection / ka if self.gain is not None else None
        return result


def fixed_station_geometry(inputs: MeasurementInputs, *, allow_upright_assumption: bool = False) -> GeometryResult:
    """Use a complete 3D pose, or an explicitly allowed upright/0deg-down model.

    A fixed station does not move through theta0+omega*t. Every dimensional input is runtime data.
    """
    world = (inputs.laser_position_world_m, inputs.hub_position_world_m,
             inputs.station_position_world_m, inputs.shaft_axis_world)
    assumptions: list[str] = []
    if all(v is not None for v in world):
        S, C, P, axis = (np.asarray(v, dtype=float) for v in world)
        norm = float(np.linalg.norm(axis))
        if norm <= 1e-12:
            raise SignalError("GEOMETRY_INVALID", "zero shaft axis")
        axis = axis / norm
        r = P - C
        model = "world_pose_fixed_station"
    elif any(v is not None for v in world):
        raise SignalError("GEOMETRY_MISSING", "partial world pose; provide all four world fields")
    else:
        if not allow_upright_assumption:
            raise SignalError("GEOMETRY_CONVENTION_REQUIRED", "explicitly allow upright rotor/0deg-down convention, or supply world pose")
        needed = {"horizontal_distance_m": inputs.horizontal_distance_m,
                  "hub_height_delta_m": inputs.hub_height_delta_m,
                  "radius_from_hub_m": inputs.radius_from_hub_m,
                  "azimuth_deg": inputs.azimuth_deg}
        missing = [key for key, value in needed.items() if value is None]
        if missing:
            raise SignalError("GEOMETRY_MISSING", ", ".join(missing))
        D, dz, R, degrees = (float(value) for value in needed.values())
        if D <= 0 or R <= 0:
            raise SignalError("GEOMETRY_INVALID", "distance and station radius must be positive")
        lateral = inputs.lateral_offset_m
        if lateral is None:
            lateral = 0.0
            assumptions.append("lateral_centering_assumed")
        theta = math.radians(degrees)
        S = np.array([-D, lateral, 0.0])
        C = np.array([0.0, 0.0, dz])
        r = np.array([0.0, R*math.sin(theta), -R*math.cos(theta)])
        P = C + r
        axis = np.array([1.0, 0.0, 0.0])
        model = "upright_rotor_0deg_down_fixed_station"
        assumptions.extend(["vertical_rotor_horizontal_axis", "azimuth_zero_down_positive_about_axis"])
    delta = P - S
    length = float(np.linalg.norm(delta))
    if length <= 1e-12:
        raise SignalError("GEOMETRY_INVALID", "laser and station coincide")
    n = delta / length
    planar = r - float(r @ axis)*axis
    radius = float(np.linalg.norm(planar))
    if radius <= 1e-12:
        raise SignalError("GEOMETRY_INVALID", "station lies on shaft axis")
    radial = planar / radius
    tangent = np.cross(axis, radial)
    if inputs.blade_length_m is not None and inputs.root_radius_m is not None:
        if radius > inputs.blade_length_m + inputs.root_radius_m + 1e-8:
            raise SignalError("POINT_OUTSIDE_BLADE", "station radius exceeds recorded blade/root geometry")
    return GeometryResult(tuple(n), tuple(axis), tuple(r), float(n @ axis), float(n @ radial),
        float(n @ tangent), float(n @ np.cross(axis, r)), length, model,
        tuple(assumptions), inputs.snapshot())
