import json
import unittest
from pathlib import Path

CATALOG = Path(__file__).resolve().parents[1] / "xscript_mcp" / "api_catalog.json"


class CatalogTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.catalog = json.loads(CATALOG.read_text(encoding="utf-8"))

    def test_backend_copy_in_sync(self):
        # 后台 AI 写脚本 grounds the model on a copy shipped inside the server package.
        backend = CATALOG.parents[3] / "backend" / "xscript_server" / "api_catalog.json"
        self.assertEqual(backend.read_bytes(), CATALOG.read_bytes(),
                         "copy ide/mcp-server/xscript_mcp/api_catalog.json to backend/xscript_server/")

    def test_modules_well_formed(self):
        names = [m["name"] for m in self.catalog["modules"]]
        self.assertEqual(len(names), len(set(names)))
        for mod in self.catalog["modules"]:
            self.assertTrue(mod.get("description"), mod["name"])
            for fn in mod.get("functions", []):
                self.assertTrue(fn.get("name") and fn.get("signature"), (mod["name"], fn))
            for cls in mod.get("classes", []):
                self.assertTrue(cls.get("name") and isinstance(cls.get("methods"), list), (mod["name"], cls))

    def _module(self, name):
        return [m for m in self.catalog["modules"] if m["name"] == name][0]

    def test_unsupported_list_does_not_name_implemented_modules(self):
        # These were stubs once; AI clients must not be told to avoid them now.
        unsupported = " ".join(self._module("ascript.android")["unsupported"]).lower()
        for implemented in ("sms", "location", "sensor", "bluetooth", "recode", "send_email", "smart", "yolov5"):
            self.assertNotIn(implemented, unsupported, implemented)
        self.assertNotRegex(unsupported, r"(^|[^.])\bplug\b(?!\.)")

    def test_screen_lists_current_vision_api(self):
        fns = {f["name"]: f for f in self._module("xscript.android.screen")["functions"]}
        for name in ("count_color", "find_color_blobs", "dominant_colors"):
            self.assertIn(name, fns)
        for name in ("find_colors", "find_all_colors", "compare_colors", "count_color"):
            self.assertIn("color_space=", fns[name]["signature"], name)
            self.assertIn("tolerance=", fns[name]["signature"], name)
        for name in ("find_image", "find_all_images"):
            self.assertIn("method=", fns[name]["signature"], name)
        for engine in ("auto", "paddle_v6t", "paddle_v6s", "mlkit", "paddle_v4"):
            self.assertIn(engine, fns["ocr"]["doc"], engine)
        self.assertEqual(len(fns), len(self._module("xscript.android.screen")["functions"]), "duplicate names")

    def test_covers_native_and_ascript_packages(self):
        names = {m["name"] for m in self.catalog["modules"]}
        for expected in (
            "xscript.android.action",
            "xscript.android.node",
            "xscript.android.screen",
            "xscript.android.system",
            "xscript.android.ui",
            "ascript.android",
        ):
            self.assertIn(expected, names)

    def test_catalog_names_exist_in_runtime_source(self):
        # Every plain function listed for xscript.android.* must be defined in android/python-runtime.
        runtime = Path(__file__).resolve().parents[3] / "android" / "python-runtime"
        for mod in self.catalog["modules"]:
            if not mod["name"].startswith("xscript.android."):
                continue
            src = (runtime / (mod["name"].replace(".", "/") + ".py")).read_text(encoding="utf-8")
            for fn in mod.get("functions", []):
                for name in fn["name"].replace(" ", "").split("/"):
                    self.assertIn("def %s(" % name, src, "%s.%s" % (mod["name"], name))


class ServerCatalogToolsTest(unittest.TestCase):
    def setUp(self):
        try:
            from xscript_mcp import server
        except ImportError as e:  # mcp SDK not installed in this interpreter
            self.skipTest(str(e))
        self.server = server

    def test_get_module_apis_filters(self):
        out = json.loads(self.server.get_module_apis("ascript"))
        self.assertEqual([m["name"] for m in out["modules"]], ["ascript.android"])

    def test_search_api_finds_ocr(self):
        out = json.loads(self.server.search_api("ocr_click"))
        self.assertIn("xscript.android.screen", [m["name"] for m in out["modules"]])


if __name__ == "__main__":
    unittest.main()
