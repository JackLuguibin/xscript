import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "docs_link_issue.py"
sys.path.insert(0, str(SCRIPT.parent))
import check_docs  # noqa: E402

# A fake `gh`: answers `issue list` from $FAKE_OPEN (a JSON list) and logs every call as one JSON line.
FAKE_GH = textwrap.dedent("""
    #!/usr/bin/env python3
    import json, os, sys
    with open(os.environ["FAKE_LOG"], "a") as f:
        f.write(json.dumps(sys.argv[1:]) + "\\n")
    if sys.argv[1:3] == ["issue", "list"]:
        print(os.environ.get("FAKE_OPEN", "[]"))
""").lstrip()


class IssueTest(unittest.TestCase):
    def run_with(self, report, open_issues):
        with tempfile.TemporaryDirectory() as d:
            gh = os.path.join(d, "gh")
            Path(gh).write_text(FAKE_GH)
            os.chmod(gh, 0o755)
            rep = os.path.join(d, "broken.md")
            Path(rep).write_text(report, encoding="utf-8")
            log = os.path.join(d, "log")
            env = dict(os.environ, GH_BIN=gh, FAKE_LOG=log, FAKE_OPEN=json.dumps(open_issues), RUN_URL="https://ci/run/1")
            out = subprocess.run([sys.executable, str(SCRIPT), rep], env=env, capture_output=True, text=True, check=True).stdout
            calls = [json.loads(x) for x in Path(log).read_text().splitlines()] if os.path.exists(log) else []
            return out, [c for c in calls if c[:2] != ["issue", "list"]]

    def test_broken_links_open_an_issue(self):
        out, calls = self.run_with("- https://x.example/a — HTTP 404（`docs/A.md:3`）\n", [])
        self.assertEqual(calls[0][:4], ["issue", "create", "--title", "文档外部链接失效（每周检查）"])
        self.assertIn("https://x.example/a — HTTP 404", calls[0][5])
        self.assertIn("https://ci/run/1", calls[0][5])

    def test_still_broken_comments_on_the_open_issue(self):
        _, calls = self.run_with("- https://x.example/a — HTTP 404（`docs/A.md:3`）\n",
                                 [{"number": 7, "title": "文档外部链接失效（每周检查）"}, {"number": 8, "title": "other"}])
        self.assertEqual(calls[0][:3], ["issue", "comment", "7"])

    def test_fixed_closes_it_and_nothing_to_do_does_nothing(self):
        _, calls = self.run_with("", [{"number": 7, "title": "文档外部链接失效（每周检查）"}])
        self.assertEqual(calls[0][:3], ["issue", "close", "7"])
        out, calls = self.run_with("\n", [{"number": 9, "title": "文档外部链接失效（每周检查）旧"}])
        self.assertEqual(calls, [])
        self.assertIn("no broken external links", out)


class ReportTest(unittest.TestCase):
    def test_report_lists_each_url_once_with_every_place(self):
        ext = [("docs/A.md", 3, "https://a"), ("README.md", 9, "https://a"), ("docs/B.md", 1, "https://ok")]
        self.assertEqual(check_docs.external_report(ext, {"https://a": "HTTP 404"}),
                         "- https://a — HTTP 404（`docs/A.md:3`、`README.md:9`）\n")
        self.assertEqual(check_docs.external_report(ext, {}), "")


if __name__ == "__main__":
    unittest.main()
