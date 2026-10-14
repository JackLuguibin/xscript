import types
import unittest
from unittest.mock import Mock, patch
from xscript.runtime.resources import cleanup
from xscript.runtime.eval_runner import run


class ResourcesTest(unittest.TestCase):
    def test_both_modules_and_native_resources_close(self):
        sensor = types.SimpleNamespace(_shutdown=Mock())
        location = types.SimpleNamespace(_shutdown=Mock())
        bridge = Mock()
        with patch.dict('sys.modules', {'ascript.android.sensor': sensor, 'ascript.android.location': location}), patch('xscript.runtime.bridge.bridge', bridge):
            cleanup()
        sensor._shutdown.assert_called_once()
        location._shutdown.assert_called_once()
        bridge.system.assert_called_once_with('device_resources_close', {})

    def test_one_failure_does_not_skip_other_resources(self):
        sensor = types.SimpleNamespace(_shutdown=Mock(side_effect=RuntimeError('callback cleanup failed')))
        location = types.SimpleNamespace(_shutdown=Mock())
        with patch.dict('sys.modules', {'ascript.android.sensor': sensor, 'ascript.android.location': location}), patch('xscript.runtime.bridge.bridge') as bridge, patch('xscript.runtime.resources.traceback.print_exc'):
            cleanup()
        location._shutdown.assert_called_once()
        bridge.system.assert_called_once()

    def test_eval_releases_subscriptions_on_success_and_failure(self):
        for code in ('_result=42', 'raise ValueError("boom")', 'raise SystemExit(2)'):
            with patch('xscript.runtime.resources.cleanup') as close:
                try:
                    run(code)
                except SystemExit:
                    pass
                close.assert_called_once()
