"""P100S driver merged with supplied 转盘控制器/1016/app feedback API (2026-10-16).

No imports open a port, enable SON, or bypass firmware limits.
"""
from .motor_controller import MotorController, MotorError, CommunicationError, PositionFeedback, GuardConfig
from .trajectory import TrajectoryPoint, TrajectoryStatus
