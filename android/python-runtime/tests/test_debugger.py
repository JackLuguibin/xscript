import sys
import unittest
from unittest.mock import Mock, patch

from xscript.runtime import debugger


class DebuggerTest(unittest.TestCase):
    def test_local_in_process_adapter_and_native_thread(self):
        api = Mock()
        api.is_client_connected.return_value = True
        timer = Mock()
        with patch.dict(sys.modules, {"debugpy": api}), patch.object(debugger.threading, "Timer", return_value=timer):
            debugger.start()
        api.listen.assert_called_once_with(("127.0.0.1", 5678), in_process_debug_adapter=True)
        api.configure.assert_called_once_with(subProcess=False)
        api.wait_for_client.assert_called_once()
        api.debug_this_thread.assert_called_once()
        timer.cancel.assert_called_once()

    def test_timeout_does_not_execute_without_debugger(self):
        api = Mock()
        api.is_client_connected.return_value = False
        with patch.dict(sys.modules, {"debugpy": api}), self.assertRaises(TimeoutError):
            debugger.start(timeout=10)
        api.debug_this_thread.assert_not_called()

    def test_listener_error_is_explicit(self):
        api = Mock()
        api.listen.side_effect = OSError("address already in use")
        with patch.dict(sys.modules, {"debugpy": api}), self.assertRaises(OSError):
            debugger.start()
        api.wait_for_client.assert_not_called()
