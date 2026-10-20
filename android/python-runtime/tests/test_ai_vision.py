"""screen.ai_find / ai_ask against an offline OpenAI-compatible mock server. No real keys."""
import base64
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

import cv2
import numpy as np

from xscript.android import ai, screen

FAKE_KEY = "sk-test-not-a-real-key"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        raw = self.rfile.read(int(self.headers["Content-Length"]))
        self.server.requests.append((self.path, dict(self.headers), json.loads(raw)))
        status, body = self.server.replies.pop(0)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())


def completion(content):
    return {"id": "x", "object": "chat.completion",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": content}}]}


class AiVisionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = "http://127.0.0.1:%d/v1" % cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        ai.reset()
        self.server.requests, self.server.replies = [], []
        self.image = np.zeros((640, 320, 3), np.uint8)  # 320 wide, 640 tall
        self.addCleanup(ai.reset)

    def reply(self, content, status=200):
        self.server.replies.append((status, completion(content) if status == 200 else content))

    def test_unconfigured_raises_without_network(self):
        with patch.dict("os.environ", {}, clear=True):
            with self.assertRaises(ai.AiError):
                screen.ai_find("ok", image=self.image)
        self.assertEqual(ai.status()["configured"], False)
        self.assertEqual(self.server.requests, [])

    def test_env_defaults_and_status_hides_key(self):
        env = {"XSCRIPT_AI_BASE_URL": self.url, "XSCRIPT_AI_MODEL": "m", "XSCRIPT_AI_KEY": FAKE_KEY}
        with patch.dict("os.environ", env, clear=True):
            self.reply("yes")
            self.assertEqual(screen.ai_ask("login page?", image=self.image), "yes")
        self.assertNotIn(FAKE_KEY, json.dumps(ai.status()))
        self.assertEqual(self.server.requests[0][1]["Authorization"], "Bearer " + FAKE_KEY)

    def test_find_request_shape_and_pixel_mapping(self):
        ai.config(self.url, FAKE_KEY, "qwen-vl")
        self.reply('```json\n{"results": [{"label": "关闭", "box": [64, 128, 128, 192], "confidence": 0.8}]}\n```')
        hit = screen.ai_find("红色的关闭按钮", image=self.image)
        path, headers, body = self.server.requests[0]
        self.assertEqual(path, "/v1/chat/completions")
        self.assertEqual(body["model"], "qwen-vl")
        self.assertEqual(body["temperature"], 0)
        self.assertNotIn("response_format", body)
        text, img = body["messages"][0]["content"]
        self.assertIn("红色的关闭按钮", text["text"])
        url = img["image_url"]["url"]
        self.assertTrue(url.startswith("data:image/jpeg;base64,"))
        up = cv2.imdecode(np.frombuffer(base64.b64decode(url.split(",", 1)[1]), np.uint8), 1)
        self.assertIn("%dx%d" % (up.shape[1], up.shape[0]), text["text"])
        sx, sy = 320 / up.shape[1], 640 / up.shape[0]
        self.assertEqual(hit["text"], "关闭")
        self.assertEqual(hit["rect"], [round(64 * sx), round(128 * sy), round(128 * sx), round(192 * sy)])
        self.assertEqual(hit["center_x"], (hit["rect"][0] + hit["rect"][2]) // 2)
        self.assertAlmostEqual(hit["confidence"], 0.8)

    def test_rect_offset_norm1000_and_filtering(self):
        ai.config(self.url, "", "m", coords="norm1000", json_mode=True)
        self.reply('<think>hmm</think>[{"bbox_2d": [0, 0, 500, 500], "label": "a"},'
                   '{"bbox_2d": [0, 0, 1000, 1000], "label": "b", "confidence": 0.2},'
                   '{"label": "no box"}, {"bbox_2d": [5, 5, 5, 5]}]')
        hits = screen.ai_find_all("x", rect=[100, 200, 300, 400], image=self.image, confidence=0.5)
        _, headers, body = self.server.requests[0]
        self.assertNotIn("Authorization", headers)  # local servers without a key
        self.assertEqual(body["response_format"], {"type": "json_object"})
        self.assertEqual([h["text"] for h in hits], ["a"])
        self.assertEqual(hits[0]["rect"], [100, 200, 200, 300])

    def test_auto_coords_ratio_and_not_found(self):
        ai.config(self.url, FAKE_KEY, "m", coords="auto")
        self.reply('{"results": [{"box": [0.5, 0.5, 1.0, 1.0]}]}')
        self.assertEqual(ai.find("x", image=self.image)["rect"], [160, 320, 320, 640])
        self.reply('Nothing there. {"results": []}')
        self.assertIsNone(screen.ai_find("x", image=self.image))
        self.reply("{\"results\": []}")
        self.assertFalse(ai.exists("x", image=self.image))

    def test_ask_uses_system_prompt_and_strips_thinking(self):
        ai.config(self.url, FAKE_KEY, "m")
        self.reply([{"type": "text", "text": "<think>...</think> 是登录页"}])
        self.assertEqual(screen.ai_ask("当前是不是登录页？", image=self.image), "是登录页")
        msgs = self.server.requests[0][2]["messages"]
        self.assertEqual(msgs[0]["role"], "system")
        self.assertEqual(msgs[1]["content"][0]["text"], "当前是不是登录页？")

    def test_http_and_protocol_errors(self):
        ai.config(self.url, FAKE_KEY, "m")
        self.reply({"error": {"message": "invalid api key"}}, 401)
        with self.assertRaises(ai.AiError) as cm:
            screen.ai_ask("q", image=self.image)
        self.assertEqual(cm.exception.status, 401)
        self.assertIn("invalid api key", str(cm.exception))
        self.assertNotIn(FAKE_KEY, str(cm.exception))
        self.server.replies.append((200, {"unexpected": True}))
        with self.assertRaises(ai.AiError):
            screen.ai_ask("q", image=self.image)
        self.reply("I cannot see any JSON here")
        with self.assertRaises(ai.AiError):
            screen.ai_find("x", image=self.image)

    def test_unreachable_endpoint(self):
        ai.config("http://127.0.0.1:9/v1", FAKE_KEY, "m", timeout=2)
        with self.assertRaises(ai.AiError) as cm:
            screen.ai_ask("q", image=self.image)
        self.assertIsNone(cm.exception.status)

    def test_config_validation(self):
        for kwargs in (dict(base_url="ftp://h/v1"), dict(base_url="http://u:p@h/v1"),
                       dict(coords="weird"), dict(timeout=0), dict(image_tokens=0)):
            args = dict(base_url=self.url, model="m")
            args.update(kwargs)
            with self.assertRaises(ValueError):
                ai.config(**args)
        with self.assertRaises(ValueError):
            ai.config(self.url, model="m") or ai.find("", image=self.image)

    def test_click_taps_center(self):
        ai.config(self.url, FAKE_KEY, "m")
        self.reply('{"results": [{"box": [0, 0, 32, 32]}]}')
        with patch("xscript.android.action.click", return_value=True) as tap, \
                patch("xscript.android.image.to_bgr", return_value=self.image):
            self.assertTrue(screen.ai_click("x"))
        tap.assert_called_once()


if __name__ == "__main__":
    unittest.main()
