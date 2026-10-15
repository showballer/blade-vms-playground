"""P100S driver adapted from the supplied 转盘控制器/上位机 API (2026-10-14).

No imports open a port, enable SON, or bypass firmware limits.
"""
from .motor_controller import MotorController, MotorError, CommunicationError
