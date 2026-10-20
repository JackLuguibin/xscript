"""scripts/gen_api_catalog.py: the catalog follows the stubs, and drift in either direction fails."""
import copy
import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("gen_api_catalog", ROOT / "scripts" / "gen_api_catalog.py")
gen = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gen)


class GenApiCatalogTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.src = json.loads(gen.SRC.read_text(encoding="utf-8"))

    def mod(self, src, name):
        return [m for m in src["modules"] if m["name"] == name][0]

    def build(self, src):
        return {m["name"]: m for m in json.loads(gen.build(src))["modules"]}

    def test_both_copies_are_current(self):
        self.assertEqual(gen.main(["--check"]), 0)
        text = gen.build()
        for p in gen.OUTS:
            self.assertEqual(p.read_text(encoding="utf-8"), text, p)

    def test_signatures_come_from_the_stubs(self):
        cat = self.build(self.src)
        fns = {f["name"]: f for f in cat["xscript.android.screen"]["functions"]}
        self.assertIn("method=None", fns["find_image"]["signature"])
        self.assertTrue(fns["find_image"]["signature"].endswith(" -> dict | None"))
        on_key = {f["name"]: f for f in cat["xscript.android.event"]["functions"]}["on_key"]
        self.assertTrue(on_key["signature"].startswith("@on_key("))
        group = {f["name"]: f for f in cat["xscript.android.action"]["functions"]}["back / home / recents"]
        self.assertEqual(group["signature"], "back() -> bool; home() -> bool; recents() -> bool")
        pip = {f["name"]: f for f in cat["xscript.android.pip"]["functions"]}
        self.assertNotIn("log=", pip["install"]["signature"])
        self.assertNotIn("finder=", pip["install"]["signature"])
        self.assertIn("upgrade=False", pip["install"]["signature"])

    def test_doc_falls_back_to_the_stub_docstring(self):
        src = copy.deepcopy(self.src)
        f = [f for f in self.mod(src, "xscript.android.action")["functions"] if f.get("name") == "click"][0]
        f.pop("doc")
        doc = {x["name"]: x for x in self.build(src)["xscript.android.action"]["functions"]}["click"]["doc"]
        self.assertTrue(doc.startswith("Tap (x, y)."), doc)
        self.assertNotIn("\n", doc)

    def test_unlisted_stub_function_fails(self):
        src = copy.deepcopy(self.src)
        m = self.mod(src, "xscript.android.screen")
        m["functions"] = [f for f in m["functions"] if f.get("name") != "dominant_colors"]
        with self.assertRaisesRegex(gen.CatalogError, "dominant_colors.*omit"):
            gen.build(src)

    def test_name_missing_from_stubs_fails(self):
        src = copy.deepcopy(self.src)
        self.mod(src, "xscript.android.screen")["functions"].append({"name": "no_such_api"})
        with self.assertRaisesRegex(gen.CatalogError, "no_such_api.*not in the stubs"):
            gen.build(src)

    def test_unlisted_class_and_bad_hide_fail(self):
        src = copy.deepcopy(self.src)
        self.mod(src, "xscript.android.pip")["omit_classes"].remove("Finder")
        with self.assertRaisesRegex(gen.CatalogError, "Finder"):
            gen.build(src)
        src = copy.deepcopy(self.src)
        f = [f for f in self.mod(src, "xscript.android.pip")["functions"] if f.get("name") == "install"][0]
        f["hide"] = ["nope"]
        with self.assertRaisesRegex(gen.CatalogError, "unknown parameters"):
            gen.build(src)

    def test_duplicate_listing_fails(self):
        src = copy.deepcopy(self.src)
        self.mod(src, "xscript.android.screen")["functions"].append({"name": "ocr"})
        with self.assertRaisesRegex(gen.CatalogError, "listed twice"):
            gen.build(src)

    def test_reexported_functions_resolve_in_their_source_stub(self):
        loc = {f["name"]: f for f in self.build(self.src)["xscript.android.location"]["functions"]}
        self.assertEqual(loc["convert"]["signature"], "convert(lon, lat, from_type, to_type) -> (lon, lat)")
        self.assertIn("wgs84_to_bd09 / bd09_to_wgs84", loc)
        self.assertTrue(loc["request"]["signature"].startswith("request(call_back=None"))
        # a new public function in a stub the module re-exports from must be listed or omitted
        src = copy.deepcopy(self.src)
        m = self.mod(src, "xscript.android.location")
        m["functions"] = [f for f in m["functions"] if f.get("name") != "coord_type"]
        with self.assertRaisesRegex(gen.CatalogError, "coords functions \\['coord_type'\\]"):
            gen.build(src)
        m["omit"] = ["coord_type"]
        gen.build(src)
        m["functions"].append({"name": "nope", "from": "xscript.android.coords"})
        with self.assertRaisesRegex(gen.CatalogError, "not defined in the xscript.android.coords stub"):
            gen.build(src)

    def test_hand_written_modules_pass_through(self):
        cat = self.build(self.src)
        self.assertEqual(cat["devtools"], {k: v for k, v in self.mod(self.src, "devtools").items() if k != "stub"})
        self.assertTrue(cat["ascript.android"]["unsupported"])


if __name__ == "__main__":
    unittest.main()
