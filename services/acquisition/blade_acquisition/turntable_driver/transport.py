"""app(5) compatible TCP byte stream; never reconnect or replay motor commands."""
import select
import socket
import time

from ..serial_ports import tcp_endpoint


class TcpTransport:
    def __init__(self, endpoint, *, timeout=2.0, write_timeout=2.0, **_serial_options):
        target = tcp_endpoint(endpoint)
        if target is None:
            raise ValueError("TCP地址须为 tcp://IPv4:端口")
        self._socket = socket.create_connection(target, timeout=timeout or 2.0)
        try:
            self._socket.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            self._socket.setblocking(False)
        except Exception:
            self._socket.close()
            raise
        self.write_timeout = write_timeout

    @property
    def in_waiting(self):
        if not select.select([self._socket], [], [], 0)[0]:
            return 0
        try:
            data = self._socket.recv(4096, socket.MSG_PEEK)
        except BlockingIOError:
            return 0
        if not data:
            raise ConnectionError("转盘TCP连接已关闭，请检查设备状态后手动重连；未重发运动")
        return len(data)

    def read(self, size):
        if size <= 0:
            return b''
        try:
            data = self._socket.recv(size)
        except BlockingIOError:
            return b''
        if not data:
            raise ConnectionError("转盘TCP连接已关闭")
        return data

    def read_available(self, timeout):
        """Wake on arriving bytes instead of introducing a 5 ms polling tick."""
        if not select.select([self._socket], [], [], max(0, timeout))[0]:
            return b''
        return self.read(4096)

    def write(self, data):
        view, sent = memoryview(data), 0
        deadline = time.monotonic() + self.write_timeout
        while sent < len(view):
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([], [self._socket], [], remaining)[1]:
                raise TimeoutError("转盘TCP发送超时，执行结果未知，未自动重发")
            try:
                count = self._socket.send(view[sent:])
            except BlockingIOError:
                continue
            if not count:
                raise ConnectionError("转盘TCP发送期间连接已关闭")
            sent += count
        return sent

    def reset_input_buffer(self):
        for _ in range(16):
            waiting = self.in_waiting
            if not waiting:
                return
            self.read(waiting)
        raise ConnectionError("转盘TCP接收流持续异常，未发送新命令")

    def close(self):
        self._socket.close()
