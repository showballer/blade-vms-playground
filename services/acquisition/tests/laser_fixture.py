"""Explicit fake readbacks for tests that otherwise use fake motion/DAQ adapters."""
import time


class FakeLaserPanel:
    def __init__(self, config):
        self.config = config

    def run_command(self, action="read", *args, **kwargs):
        return {"deviceIp": self.config.device_ip, "readAt": time.time(), "source": "device-readback",
                "fields": {"laser": {"supported": True, "value": 1 if action == "laser_on" else 0}}}
