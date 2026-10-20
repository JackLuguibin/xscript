"""agent.run against an offline OpenAI-compatible mock server. No real keys, no real gestures."""
import json
import threading
import unittest
from unittest.mock import patch

import numpy as np

from xscript.android import agent, ai
from tests.test_ai_vision import FAKE_KEY, Handler, completion
from http.server import ThreadingHTTPServer


class AgentTest(unittest.TestCase):
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
        self.server.requests, self.server.replies = [], []
        ai.config(self.url, FAKE_KEY, "vl", image_tokens=4096)
        self.addCleanup(ai.reset)
        self.image = np.zeros((640, 320, 3), np.uint8)
        self.calls = []
        names = ("click", "long_click", "swipe", "input", "back", "home", "recents")
        self.patches = [patch("xscript.android.action." + n,
                              side_effect=lambda *a, _n=n: self.calls.append((_n,) + a) or True) for n in names]
        for p in self.patches:
            p.start()
            self.addCleanup(p.stop)

    def say(self, *actions):
        for a in actions:
            self.server.replies.append((200, completion(a if isinstance(a, str) else json.dumps(a))))

    def go(self, goal="open settings", **kw):
        kw.setdefault("settle", 0)
        kw.setdefault("log", False)
        return agent.run(goal, capture=lambda: self.image, **kw)

    def test_loop_performs_actions_until_done(self):
        self.say({"action": "click", "x": 100, "y": 200, "reason": "settings icon"},
                 '```json\n{"action": "swipe", "x1": 160, "y1": 500, "x2": 160, "y2": 100}\n```',
                 {"action": "back"}, {"action": "done", "message": "WLAN open"})
        steps = []
        res = self.go(on_step=steps.append)
        self.assertEqual((res.status, res.message, res.ok), ("done", "WLAN open", True))
        self.assertEqual(self.calls, [("click", 100, 200), ("swipe", 160, 500, 160, 100), ("back",)])
        self.assertEqual([s["step"] for s in steps], [1, 2, 3, 4])
        self.assertEqual(steps[0]["reason"], "settings icon")
        _, headers, body = self.server.requests[0]
        self.assertEqual(headers["Authorization"], "Bearer " + FAKE_KEY)
        system, user = body["messages"]
        self.assertIn("320x640", system["content"])
        self.assertNotIn('"input"', system["content"])  # not allowlisted -> not offered
        self.assertIn("Goal: open settings", user["content"][0]["text"])
        self.assertTrue(user["content"][1]["image_url"]["url"].startswith("data:image/jpeg;base64,"))
        later = self.server.requests[2][2]["messages"][1]["content"][0]["text"]
        self.assertIn('1. {"action": "click", "x": 100, "y": 200}', later)

    def test_log_lines(self):
        import io, contextlib
        self.say({"action": "click", "x": 9999, "y": 1}, {"action": "back", "reason": "关闭弹窗"}, {"action": "done"})
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.go(log=True, max_steps=5)
        lines = out.getvalue().splitlines()
        self.assertEqual(len(lines), 3)
        self.assertTrue(lines[0].startswith("[agent] 1/5 ") and "rejected: point" in lines[0])
        self.assertEqual(lines[1], '[agent] 2/5 {"action": "back"} ok (关闭弹窗)')

    def test_step_limit(self):
        self.say(*[{"action": "back"}] * 3)
        res = self.go(max_steps=3)
        self.assertEqual(res.status, "max_steps")
        self.assertEqual(len(self.calls), 3)
        self.assertEqual(len(self.server.requests), 3)

    def test_disallowed_and_out_of_bounds_actions_never_run(self):
        self.say({"action": "input", "text": "pw"}, {"action": "click", "x": 9999, "y": 5},
                 {"action": "click", "x": True, "y": 5}, {"action": "shell", "cmd": "rm -rf /"},
                 "no json here", {"action": "fail", "message": "stuck"})
        res = self.go(max_invalid=10)
        self.assertEqual((res.status, res.message), ("failed", "stuck"))
        self.assertEqual(self.calls, [])
        errors = [s["error"] for s in res.steps[:5]]
        self.assertIn("not allowed", errors[0])
        self.assertIn("outside", errors[1])
        self.assertIn("must be a number", errors[2])
        self.assertIn("not allowed", errors[3])
        self.assertIn("not JSON", errors[4])
        # rejected steps are fed back so the model can correct itself
        self.assertIn("rejected: action 'input' is not allowed", self.server.requests[1][2]["messages"][1]["content"][0]["text"])

    def test_too_many_invalid_replies_fails(self):
        self.say(*["nope"] * 3)
        res = self.go(max_invalid=3, max_steps=10)
        self.assertEqual(res.status, "failed")
        self.assertEqual(len(self.server.requests), 3)

    def test_allowlist_widening_and_input(self):
        self.say({"action": "input", "text": "你好"}, {"action": "home"}, {"action": "done"})
        res = self.go(actions=agent.ACTIONS)
        self.assertTrue(res.ok)
        self.assertEqual(self.calls, [("input", "你好"), ("home",)])
        with self.assertRaises(ValueError):
            agent.Agent("x", actions=("click", "shell"))
        with self.assertRaises(ValueError):
            agent.Agent("x", max_steps=0)

    def test_stop_aborts_before_next_action(self):
        holder = {}

        def on_step(rec):
            holder["agent"].stop()

        self.say({"action": "click", "x": 1, "y": 1}, {"action": "click", "x": 2, "y": 2})
        a = agent.Agent("g", on_step=on_step, settle=0, capture=lambda: self.image, log=False)
        holder["agent"] = a
        res = a.run()
        self.assertEqual(res.status, "aborted")
        self.assertEqual(self.calls, [("click", 1, 1)])

    def test_stop_all_from_another_thread_interrupts_wait(self):
        self.say({"action": "wait", "seconds": 60})
        result = {}
        t = threading.Thread(target=lambda: result.setdefault("r", self.go(max_steps=5)))
        t.start()
        for _ in range(200):
            if self.server.requests:
                break
            threading.Event().wait(0.01)
        threading.Event().wait(0.1)
        self.assertEqual(agent.stop_all(), 1)
        t.join(5)
        self.assertFalse(t.is_alive())
        self.assertEqual(result["r"].status, "aborted")
        self.assertEqual(agent.stop_all(), 0)

    def test_timeout(self):
        self.say({"action": "wait", "seconds": 0.3}, {"action": "back"})
        res = self.go(timeout=0.2)
        self.assertEqual(res.status, "timeout")
        self.assertEqual(self.calls, [])

    def test_norm1000_coords_and_rect_offset(self):
        ai.config(self.url, FAKE_KEY, "vl", coords="norm1000", image_tokens=4096)
        self.say({"action": "click", "x": 500, "y": 500}, {"action": "done"})
        self.go(rect=[0, 100, 320, 500])
        self.assertEqual(self.calls, [("click", 160, 300)])

    def test_dry_run_and_auth_error_propagates(self):
        self.say({"action": "back"}, {"action": "done"})
        self.assertTrue(self.go(dry_run=True).ok)
        self.assertEqual(self.calls, [])
        self.server.replies.append((401, {"error": {"message": "bad key"}}))
        with self.assertRaises(ai.AiError) as ctx:
            self.go()
        self.assertEqual(ctx.exception.status, 401)
        self.assertNotIn(FAKE_KEY, str(ctx.exception))

    def test_server_errors_count_as_invalid_then_recover(self):
        self.server.replies.append((503, {"error": "busy"}))
        self.say({"action": "done", "message": "ok"})
        res = self.go()
        self.assertTrue(res.ok)
        self.assertIn("503", res.steps[0]["error"])


if __name__ == "__main__":
    unittest.main()
