"""The web IDE parser (tools/editor-parse.js) is tested against scripts/tests/fixtures/python-syntax.json:
source samples with the line CPython's ast.parse reports (null = valid). This keeps that fixture honest.
Regenerate after adding samples:  python3 scripts/tests/test_python_syntax.py --write
"""
import ast
import json
import pathlib
import sys
import unittest
import warnings

FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "python-syntax.json"


def cpython_line(src):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        try:
            ast.parse(src, feature_version=(3, 10))
            return None
        except SyntaxError as e:
            return e.lineno


@unittest.skipIf(sys.version_info < (3, 10), "needs the PEG parser's error positions")
class FixtureMatchesCPython(unittest.TestCase):
    def test_lines(self):
        cases = json.loads(FIXTURE.read_text(encoding="utf-8"))
        self.assertGreater(len(cases), 100)
        for c in cases:
            with self.subTest(src=c["src"]):
                self.assertEqual(cpython_line(c["src"]), c["line"])


if __name__ == "__main__" and "--write" in sys.argv:
    cases = json.loads(FIXTURE.read_text(encoding="utf-8"))
    for c in cases:
        c["line"] = cpython_line(c["src"])
    FIXTURE.write_text(json.dumps(cases, ensure_ascii=False, indent=0) + "\n", encoding="utf-8")
elif __name__ == "__main__":
    unittest.main()
