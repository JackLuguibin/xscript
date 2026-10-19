"""The benchmark harness (scripts/bench) keeps running and its synthetic frame keeps its known targets."""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "..", "scripts", "bench"))

try:
    import cv2  # noqa: F401
    import numpy  # noqa: F401
    import algo_bench
except Exception:  # pragma: no cover - the harness needs numpy + cv2
    algo_bench = None


@unittest.skipIf(algo_bench is None, "numpy / cv2 missing")
class AlgoBenchTest(unittest.TestCase):
    def test_runs_and_finds_known_targets(self):
        rep = algo_bench.run(only=["frame.", "colors.", "image.find_1", "image.find_absent"], repeat=2, paddle=False)
        by = {r["name"]: r for r in rep["results"]}
        self.assertFalse([r for r in rep["results"] if "error" in r])
        self.assertEqual(by["colors.find_3pt_hit"]["first"], [700, 2210])
        self.assertEqual(by["colors.find_3pt_absent"]["hits"], 0)
        self.assertEqual(by["image.find_1"]["first"][:2], [650, 1245])
        self.assertEqual(by["image.find_absent"]["hits"], 0)
        for r in rep["results"]:
            self.assertGreaterEqual(r["p95_ms"], r["median_ms"])

    def test_device_only_paths_are_skipped_on_pc(self):
        rep = algo_bench.run(only=["capture.", "bridge."], repeat=1, paddle=False)
        self.assertEqual(rep["results"], [])


if __name__ == "__main__":
    unittest.main()
