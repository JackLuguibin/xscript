import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import check_docs  # noqa: E402


class SlugTest(unittest.TestCase):
    def test_github_rules(self):
        self.assertEqual(check_docs.slug("可靠性、安全与性能"), "可靠性安全与性能")
        self.assertEqual(check_docs.slug("P4 云控（已实现）"), "p4-云控已实现")
        self.assertEqual(check_docs.slug("14. 细化设计（P0 之后；补全）"), "14-细化设计p0-之后补全")
        self.assertEqual(check_docs.slug("Quick `start` [here](x.md)"), "quick-start-here")
        self.assertEqual(check_docs.slug("a_b - c"), "a_b---c")


class ParseTest(unittest.TestCase):
    def test_code_is_ignored_and_lines_kept(self):
        text = "a [x](one.md)\n```md\n[y](two.md)\n```\n`[z](three.md)` [w](four.md#h)\n"
        stripped = check_docs.strip_code(text)
        self.assertEqual(stripped.count("\n"), text.count("\n"))
        self.assertEqual(check_docs.links(stripped), [(1, "one.md"), (5, "four.md#h")])

    def test_longer_fence_and_tilde(self):
        text = "````\n```\n[a](x.md)\n```\n````\n~~~\n# not a heading\n~~~\n[b](y.md)\n"
        self.assertEqual(check_docs.links(check_docs.strip_code(text)), [(9, "y.md")])

    def test_image_ref_and_html(self):
        text = '![p](images/a.png "t")\n[r]: ../b.md#top\n<img src="images/c.png">\n[t [nested]](d.md)\n'
        self.assertEqual(sorted(u for _, u in check_docs.links(text)), ["../b.md#top", "d.md", "images/a.png", "images/c.png"])


class RepoFilesTest(unittest.TestCase):
    def test_no_tracked_symlinks_to_dependency_folders(self):
        # node_modules / .venv must never be committed, not even as a symlink (`node_modules/` only ignores folders)
        out = check_docs.subprocess.run(["git", "ls-files", "-s"], cwd=check_docs.ROOT, capture_output=True, text=True, check=True).stdout
        links = [line.split("\t", 1)[1] for line in out.splitlines() if line.startswith("120000 ")]
        self.assertEqual([p for p in links if Path(p).name in ("node_modules", ".venv", "venv")], [])


class RepoTest(unittest.TestCase):
    def test_repo_docs_are_clean(self):
        md = check_docs.tracked("*.md")
        problems, _ = check_docs.check_local(md)
        self.assertEqual(problems + check_docs.unused_images(), [])


if __name__ == "__main__":
    unittest.main()
