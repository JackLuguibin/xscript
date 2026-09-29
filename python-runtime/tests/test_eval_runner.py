import unittest

from xscript.runtime.eval_runner import run


class EvalRunnerTest(unittest.TestCase):
    def test_assigns_result(self):
        out = run("_result = 'ok'")
        self.assertTrue(out["ok"])
        self.assertEqual(out["result"], "ok")

    def test_error(self):
        out = run("raise ValueError('boom')")
        self.assertFalse(out["ok"])
        self.assertIn("ValueError", out["error"])


if __name__ == "__main__":
    unittest.main()
