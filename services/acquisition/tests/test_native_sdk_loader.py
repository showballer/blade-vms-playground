import ctypes as C
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from blade_acquisition.receiver import PolytecReceiver, ReceiverConfig


class NativeSdkLoaderTests(unittest.TestCase):
    def test_requires_native_library_extension_and_existing_file(self):
        with tempfile.TemporaryDirectory() as directory:
            for platform, extension in [('darwin', '.dylib'), ('win32', '.dll'), ('linux', '.so')]:
                library = Path(directory) / ('DeviceCommunication' + extension)
                library.write_bytes(b'fixture')
                receiver = PolytecReceiver(ReceiverConfig('127.0.0.1', '', str(library)))
                with patch('blade_acquisition.receiver.sys.platform', platform):
                    receiver.validate()
                other = 'win32' if platform != 'win32' else 'darwin'
                with patch('blade_acquisition.receiver.sys.platform', other):
                    with self.assertRaisesRegex(RuntimeError, '原生 SDK'):
                        receiver.validate()
                library.unlink()
                with self.assertRaises(FileNotFoundError):
                    receiver.validate()

    def test_failed_load_reports_architecture_and_closes_dll_search_scope(self):
        with tempfile.TemporaryDirectory() as directory:
            library = Path(directory) / 'DeviceCommunication.dll'
            library.write_bytes(b'fixture')
            receiver = PolytecReceiver(ReceiverConfig('127.0.0.1', '', str(library)))
            with patch('blade_acquisition.receiver.sys.platform', 'win32'), \
                 patch('blade_acquisition.receiver.os.add_dll_directory', create=True) as scope, \
                 patch.object(C, 'CDLL', side_effect=OSError('wrong architecture')):
                with self.assertRaisesRegex(RuntimeError, '处理器架构'):
                    receiver._load_api()
                scope.return_value.close.assert_called_once()
                self.assertIsNone(receiver._dll_directory)
