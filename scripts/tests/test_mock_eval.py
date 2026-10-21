"""scripts/mock_device.py POST /eval: realistic answers without executing the snippet."""
import json
import unittest
import os
import sys
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import mock_device  # noqa: E402
from mock_device import mock_eval  # noqa: E402


class MockEvalTest(unittest.TestCase):

    def test_literals_are_formatted_like_the_device(self):
        assert mock_eval("_result = 1 + 1") == {"ok": True, "result": "2", "error": ""}
        assert mock_eval("_result = 'hi'")["result"] == "hi"
        assert mock_eval("_result = {'a': [1, '中']}")["result"] == json.dumps({"a": [1, "中"]}, ensure_ascii=False)
        assert mock_eval("_result = None")["result"] == ""
        assert mock_eval("x = 1")["result"] == ""          # no _result: empty, like the device
        assert mock_eval("_result = 1\n_result = 2")["result"] == "2"


    def test_known_calls_get_canned_values_and_others_say_so(self):
        assert mock_eval("from xscript.android import device\n_result = device.screen_size()")["result"] == "[1080, 2400]"
        assert mock_eval("_result = screen.size()")["result"] == "[1080, 2400]"
        assert json.loads(mock_eval("_result = system.current_app()")["result"])["packageName"] == "com.android.launcher3"
        r = mock_eval("_result = action.click(1, 2)")
        assert r["ok"] and r["result"] == "<mock device: action.click() is not simulated>"
        assert "not simulated" in mock_eval("_result = [i for i in range(3)]")["result"]


    def test_nothing_is_executed_and_syntax_errors_fail(self):
        marker = os.path.join(os.path.dirname(__file__), "__mock_eval_marker__")
        r = mock_eval("open(%r, 'w').write('x')\n_result = 1" % marker)
        assert r["result"] == "1" and not os.path.exists(marker)
        bad = mock_eval("_result = (")
        assert bad["ok"] is False and bad["error"].startswith("SyntaxError")


    def test_http_route_uses_it(self):
        s = mock_device.serve("127.0.0.1", 0)
        try:
            req = urllib.request.Request("http://127.0.0.1:%d/eval" % s.server_address[1], data=json.dumps({"code": "_result = 6 * 7"}).encode(),
                                         headers={"Content-Type": "application/json"}, method="POST")
            with urllib.request.urlopen(req, timeout=5) as r:
                assert json.load(r) == {"ok": True, "result": "42", "error": ""}
        finally:
            s.shutdown()


if __name__ == "__main__":
    unittest.main()
