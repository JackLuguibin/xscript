"""Vision compatibility contract exercised against an offline loopback server."""
import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
import urllib.error
import unittest
from unittest.mock import patch

import cv2
import numpy as np

from ascript.android.vlm import asai, _frame


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        raw = self.rfile.read(int(self.headers["Content-Length"]))
        self.server.requests.append((self.path, dict(self.headers), json.loads(raw)))
        status, reply, headers = self.server.responses.pop(0)
        self.send_response(status)
        for key, value in headers.items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(reply if isinstance(reply, bytes) else json.dumps(reply).encode())


class VlmCompatTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = "http://127.0.0.1:%d/v1" % cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        asai._client_instance, asai._coord_space = None, None
        self.server.responses, self.server.requests = [], []
        self.image = np.zeros((400, 300, 3), dtype=np.uint8)

    def configure(self, **kwargs):
        asai.init("test-key", self.url, **kwargs)

    def reply(self, value, code=200, **headers):
        self.server.responses.append((code, value, headers))

    def test_requires_explicit_init_and_service(self):
        with patch.dict("os.environ", {"ASCRIPT_AI_KEY": "present"}, clear=True):
            with self.assertRaises(asai.NotReadyError):
                asai.find("button", image=self.image)
            with self.assertRaises(asai.NotReadyError):
                asai.init("key")
        self.assertEqual(asai.status(), {"configured": False, "base_url": None, "coord_space": "auto"})
        self.assertEqual(self.server.requests, [])

    def test_request_crop_encode_map_and_filter(self):
        self.configure(coord_space="norm1000")
        # 200x200 crop -> 192x192 upload. Rects in reply are upload pixels.
        self.reply({"results": [{"rect": [48, 48, 144, 144], "text": "OK", "confidence": .9},
                                {"rect": [-10, -10, 250, 250], "confidence": .3}]})
        hits = asai.locate("blue button", image=self.image, rect=[50, 100, 250, 300],
                          limit=4, confidence=.5, hint="bottom")
        self.assertEqual(hits, [dict(text="OK", rect=[100, 150, 200, 250],
                                    center_x=150, center_y=200, confidence=.9)])
        path, headers, payload = self.server.requests[0]
        self.assertEqual(path, "/v1/vision/locate")
        self.assertEqual(headers["Authorization"], "Bearer test-key")
        self.assertEqual((payload["width"], payload["height"]), (192, 192))
        self.assertEqual((payload["coord_space"], payload["hint"], payload["limit"]), ("norm1000", "bottom", 4))
        decoded = cv2.imdecode(np.frombuffer(base64.b64decode(payload["image"].split(",")[1]), np.uint8), 1)
        self.assertEqual(decoded.shape, (192, 192, 3))

    def test_ask_and_structured_values(self):
        self.configure()
        self.reply({"text": "Settings"})
        self.assertEqual(asai.ask("page?", image=self.image), "Settings")
        self.assertEqual(self.server.requests[-1][2]["format"], "text")
        self.reply({"ok": True, "value": [{"title": "bread", "price": 12.5}]})
        values = asai.ask_value("items?", [{"title": str, "price": float, "stock": int}], image=self.image)
        self.assertEqual(values[0]["stock"], None)
        self.assertEqual(self.server.requests[-1][2]["fields"],
                         {"title": "string", "price": "number", "stock": "integer"})
        self.reply({"ok": False})
        self.assertIsNone(asai.ask_value("count?", int, image=self.image))
        self.reply({"ok": True, "value": "not a count"})
        with self.assertRaises(asai.ProtocolError):
            asai.ask_value("count?", int, image=self.image)

    def test_typed_http_error(self):
        self.configure()
        self.reply({"error": {"type": "rate_limit_error", "message": "slow down"}}, 429,
                   **{"Retry-After": "3", "X-Request-Id": "offline-test"})
        with self.assertRaises(asai.RateLimitError) as caught:
            asai.ask("page?", image=self.image)
        self.assertEqual((caught.exception.retry_after, caught.exception.request_id,
                          caught.exception.status_code), (3, "offline-test", 429))
        self.reply({"error": {"type": "credential_expired"}}, 401)
        with self.assertRaises(asai.CredentialExpiredError):
            asai.find("button", image=self.image)

    def test_invalid_response(self):
        self.configure()
        for reply in (b"<html>bad</html>", [], {"results": "bad"}, {"results": [{"rect": [1]}]}):
            self.reply(reply)
            with self.assertRaises(asai.ProtocolError):
                asai.find("button", image=self.image)

    def test_wait_recaptures_and_click_dispatches(self):
        self.configure()
        self.reply({"results": []})
        self.reply({"results": [{"rect": [0, 0, 32, 32]}]})
        with patch("xscript.android.image.to_bgr", return_value=self.image) as capture:
            hit = asai.wait("button", timeout=2)
        self.assertEqual(capture.call_count, 2)
        self.assertIsNotNone(hit)
        self.reply({"results": [{"rect": [0, 0, 32, 32]}]})
        with patch("ascript.android.action.click", return_value=True) as tap:
            self.assertTrue(asai.click("button", image=self.image, timeout=99))
            tap.assert_called_once_with(16, 16)
        self.reply({"results": []})
        with patch("ascript.android.action.click") as tap:
            self.assertFalse(asai.click("button", image=self.image))
            tap.assert_not_called()

    def test_network_failure_and_value_type_validation(self):
        self.configure()
        with patch("urllib.request.OpenerDirector.open", side_effect=urllib.error.URLError("offline")):
            with self.assertRaises(asai.NetworkError):
                asai.ask("page?", image=self.image)
        for invalid in ({str, int}, {"nested": []}, [], object):
            with self.assertRaises(ValueError):
                asai.ask_value("value?", invalid, image=self.image)
        self.assertEqual(self.server.requests, [])

    def test_endpoint_alias_config_atomicity_and_redaction(self):
        asai.init("secret", endpoint=self.url)
        with self.assertRaises(ValueError):
            asai.init("new", self.url, timeout=-1)
        self.assertEqual(asai._client_instance.api_key, "secret")
        self.assertNotIn("secret", json.dumps(asai.status()))
        self.assertNotIn("api_key", asai.status())

    def test_redirect_does_not_forward_credentials(self):
        self.configure()
        self.reply(b"", 302, Location=self.url + "/other")
        with self.assertRaises(asai.AsaiError):
            asai.find("button", image=self.image)
        self.assertEqual(len(self.server.requests), 1)

    def test_frame_bounds_resize_inputs(self):
        frame = _frame.prepare(self.image, [-10, 20, 100, 80], 4)
        self.assertEqual((frame.off_x, frame.off_y, frame.src_w, frame.src_h), (0, 20, 100, 60))
        hit = frame.remap({"rect": [999, 999, -99, -99]})
        self.assertEqual(hit["rect"], [0, 20, 100, 80])
        large = _frame.prepare(np.zeros((2400, 1080, 3), np.uint8), image_tokens=256)
        self.assertLess(large.net_w * large.net_h, 300000)
        for rect in ([30, 20, 10, 40], [400, 0, 500, 20]):
            with self.assertRaises(ValueError):
                _frame.prepare(self.image, rect)
        with self.assertRaises(ValueError):
            _frame.prepare(self.image, image_tokens=0)


if __name__ == "__main__":
    unittest.main()
