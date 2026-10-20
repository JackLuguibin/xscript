"""scripts/gen_editor_docs.py: signatures, full docstrings and re-exports from a small stub tree."""
import importlib.util
import tempfile
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("gen_editor_docs", ROOT / "scripts" / "gen_editor_docs.py")
gen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gen)


class GenEditorDocs(unittest.TestCase):
    def build(self, files: dict) -> dict:
        with tempfile.TemporaryDirectory() as d:
            for rel, text in files.items():
                p = Path(d) / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(textwrap.dedent(text), encoding="utf-8")
            old = gen.SRC
            gen.SRC = Path(d)
            try:
                return gen.build()
            finally:
                gen.SRC = old

    def test_functions_classes_and_reexports(self):
        docs = self.build({
            "xscript/__init__.pyi": '"""XScript."""\n',
            "xscript/android/__init__.pyi": "",
            "xscript/android/coords.pyi": '''
                """Coordinate conversion."""
                def to_wgs84(lon, lat, coord_type='wgs84'):
                    """Convert to WGS84.

                    Second paragraph.
                    """
                def _private(): ...
                class Point:
                    """A point."""
                    def __init__(self, x, y=0): ...
                    def move(self, dx): ...
                    @staticmethod
                    def origin(): ...
                ''',
            "xscript/android/location.pyi": "from xscript.android.coords import to_wgs84, Point as P\nfrom .coords import to_wgs84 as tw\nimport json\n",
            "xscript/runtime/bridge.pyi": "def call(): ...\n",
            "ascript/__init__.pyi": "",
            "ascript/android/location.pyi": "from xscript.android.location import to_wgs84\n",
        })
        self.assertEqual(docs["xscript.android.coords.to_wgs84"], ["(lon, lat, coord_type='wgs84')", "Convert to WGS84.\n\nSecond paragraph."])
        self.assertEqual(docs["xscript.android.coords"], ["", "Coordinate conversion."])
        self.assertEqual(docs["xscript.android.coords.Point"], ["(x, y=0)", "A point."])
        self.assertEqual(docs["xscript.android.coords.Point.move"][0], "(dx)")
        self.assertEqual(docs["xscript.android.coords.Point.origin"][0], "()")
        # re-exports (absolute, aliased, relative, and a chain through another stub) point at the original entry
        self.assertEqual(docs["xscript.android.location.to_wgs84"], docs["xscript.android.coords.to_wgs84"])
        self.assertEqual(docs["xscript.android.location.P.move"], docs["xscript.android.coords.Point.move"])
        self.assertEqual(docs["xscript.android.location.tw"], docs["xscript.android.coords.to_wgs84"])
        self.assertEqual(docs["ascript.android.location.to_wgs84"], docs["xscript.android.coords.to_wgs84"])
        self.assertFalse(any("_private" in k or "runtime" in k or k.endswith(".json") for k in docs), sorted(docs))
        self.assertNotIn("xscript.android", docs, "modules without docs are left out")

    def test_long_docstrings_are_capped(self):
        docs = self.build({"xscript/__init__.pyi": 'def f():\n    """%s"""\n' % ("x" * 3000)})
        self.assertEqual(len(docs["xscript.f"][1]), gen.MAX_DOC)
        self.assertTrue(docs["xscript.f"][1].endswith("..."))


if __name__ == "__main__":
    unittest.main()
