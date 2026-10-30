"""Reference algorithms. The desktop application supplies each measurement's inputs."""

__version__ = "0.1.0"

from .geometry import MeasurementInputs, SignalError, fixed_station_geometry, read_measurement_inputs
from .models import AnalysisConfig, FilterSpec, RawRecording, RealSegment, RotationReference
from .pipeline import analyze_recording
from .aggregate import aggregate_points
from .stitch import JoinConfig, build_point_preview

__all__ = ["MeasurementInputs","SignalError","fixed_station_geometry","read_measurement_inputs",
    "AnalysisConfig","FilterSpec","RawRecording","RealSegment","RotationReference",
    "analyze_recording","aggregate_points","JoinConfig","build_point_preview"]
