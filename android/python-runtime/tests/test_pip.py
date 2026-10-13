"""Runtime pip: wheel tag selection, resolution with markers/extras, install/uninstall, requirements."""

import io
import os
import shutil
import sys
import tempfile
import unittest
import zipfile

try:
    import packaging  # noqa: F401
except Exception:  # pragma: no cover
    packaging = None


def _wheel(path, name, version, requires=(), files=None, tag="py3-none-any"):
    fn = "%s-%s-%s.whl" % (name.replace("-", "_"), version, tag)
    full = os.path.join(path, fn)
    dist = "%s-%s.dist-info" % (name.replace("-", "_"), version)
    files = files or {"%s/__init__.py" % name.replace("-", "_"): "VERSION = %r\n" % version}
    with zipfile.ZipFile(full, "w") as z:
        record = []
        for rel, content in files.items():
            z.writestr(rel, content)
            record.append(rel + ",,")
        meta = "Metadata-Version: 2.1\nName: %s\nVersion: %s\n" % (name, version)
        for r in requires:
            meta += "Requires-Dist: %s\n" % r
        z.writestr(dist + "/METADATA", meta)
        z.writestr(dist + "/WHEEL", "Wheel-Version: 1.0\n")
        record += [dist + "/METADATA,,", dist + "/WHEEL,,", dist + "/RECORD,,"]
        z.writestr(dist + "/RECORD", "\n".join(record) + "\n")
    return fn


class _FakeFinder(object):
    """Stands in for the network: serves wheels from a directory."""

    def __init__(self, wheel_dir, target):
        from xscript.android import pip

        self.dir = wheel_dir
        self.target = target
        self.session = _FileSession(wheel_dir)
        self._pip = pip

    def candidates(self, name):
        from packaging.version import Version

        pip = self._pip
        out = []
        for fn in os.listdir(self.dir):
            m = pip._WHEEL.match(fn)
            if not m or pip.normalize(m.group("name")) != pip.normalize(name):
                continue
            ok, native = self.target.wheel_ok(fn)
            if ok:
                out.append(pip.Candidate(pip.normalize(name), Version(m.group("ver")), 0, fn, "file://" + fn, None,
                                         native, None))
        return out


class _Resp(object):
    def __init__(self, data):
        self._data = data

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def raise_for_status(self):
        pass

    def iter_content(self, n):
        buf = io.BytesIO(self._data)
        while True:
            chunk = buf.read(n)
            if not chunk:
                return
            yield chunk


class _FileSession(object):
    def __init__(self, d):
        self.d = d

    def get(self, url, stream=False, timeout=None, **kw):
        with open(os.path.join(self.d, url.replace("file://", "")), "rb") as f:
            return _Resp(f.read())


@unittest.skipIf(packaging is None, "packaging not installed")
class PipTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.wheels = tempfile.mkdtemp()
        os.environ["XSCRIPT_PIP_HOME"] = self.home
        from xscript.android import pip

        self.pip = pip
        self.target = pip.Target(api=24, abi="arm64-v8a")

    def tearDown(self):
        from xscript.runtime import sitepkgs

        site = sitepkgs.site_dir()
        if site in sys.path:
            sys.path.remove(site)
        for mod in [m for m in sys.modules if m.split(".")[0] in ("demo_a", "demo_b", "demo_c")]:
            del sys.modules[mod]
        os.environ.pop("XSCRIPT_PIP_HOME", None)
        shutil.rmtree(self.home, ignore_errors=True)
        shutil.rmtree(self.wheels, ignore_errors=True)

    def install(self, *reqs, **kw):
        return self.pip.install(*reqs, target=self.target, finder=_FakeFinder(self.wheels, self.target),
                                log=lambda m: None, **kw)

    def test_wheel_tags(self):
        t = self.target
        self.assertEqual(t.wheel_ok("x-1.0-py3-none-any.whl"), (True, False))
        self.assertEqual(t.wheel_ok("x-1.0-py2.py3-none-any.whl"), (True, False))
        self.assertEqual(t.wheel_ok("x-1.0-0-cp310-cp310-android_24_arm64_v8a.whl"), (True, True))
        self.assertEqual(t.wheel_ok("x-1.0-0-cp310-cp310-android_24_x86_64.whl")[0], False)
        self.assertEqual(t.wheel_ok("x-1.0-0-cp310-cp310-android_26_arm64_v8a.whl")[0], False)  # API too new
        self.assertEqual(t.wheel_ok("x-1.0-0-cp311-cp311-android_24_arm64_v8a.whl")[0], False)
        self.assertEqual(t.wheel_ok("x-1.0-cp310-cp310-manylinux_2_17_aarch64.whl")[0], False)
        self.assertEqual(t.wheel_ok("x-1.0-3-py3-none-android_24_arm64_v8a.whl"), (True, True))

    def test_install_resolves_dependencies_and_imports(self):
        _wheel(self.wheels, "demo-a", "1.0", requires=["demo-b>=2", 'demo-c; python_version < "3"'])
        _wheel(self.wheels, "demo-b", "1.5")
        _wheel(self.wheels, "demo-b", "2.1")
        _wheel(self.wheels, "demo-b", "3.0rc1")
        out = self.install("demo-a")
        names = {d["name"]: d["version"] for d in out["installed"]}
        self.assertEqual(names, {"demo-a": "1.0", "demo-b": "2.1"})  # no prerelease, marker skips demo-c
        import demo_b

        self.assertEqual(demo_b.VERSION, "2.1")
        listed = {p["name"]: p["version"] for p in self.pip.list()}
        self.assertEqual(listed.get("demo-b"), "2.1")

    def test_pinned_version_and_upgrade(self):
        _wheel(self.wheels, "demo-b", "1.5")
        _wheel(self.wheels, "demo-b", "2.1")
        self.install("demo-b==1.5")
        self.assertIn("demo-b", self.install("demo-b")["skipped"])  # 1.5 satisfies "demo-b"
        out = self.install("demo-b", upgrade=True)
        self.assertEqual(out["installed"][0]["version"], "2.1")
        dist = [e for e in os.listdir(self.pip.site_dir()) if e.startswith("demo_b-")]
        self.assertEqual(dist, ["demo_b-2.1.dist-info"])  # old dist-info removed

    def test_builtin_packages_are_not_replaced(self):
        # numpy is importable in the test venv; it counts as "built into the app".
        try:
            import numpy  # noqa: F401
        except ImportError:
            self.skipTest("numpy not installed")
        _wheel(self.wheels, "numpy", "99.0")
        out = self.install("numpy")
        self.assertEqual(out["installed"], [])
        self.assertTrue(out["skipped"]["numpy"].startswith("builtin"))

    def test_missing_wheel(self):
        with self.assertRaises(self.pip.PipError):
            self.install("does-not-exist")

    def test_uninstall(self):
        _wheel(self.wheels, "demo-b", "2.1")
        self.install("demo-b")
        pkg = os.path.join(self.pip.site_dir(), "demo_b")
        self.assertTrue(os.path.isdir(pkg))
        self.assertEqual(self.pip.uninstall("demo_b", log=lambda m: None)["removed"], ["demo-b"])
        self.assertFalse(os.path.exists(pkg))

    def test_native_libs_merge(self):
        _wheel(self.wheels, "demo-c", "1.0", files={"chaquopy/lib/libdemo.so": "x", "demo_c/__init__.py": ""},
               tag="3-py3-none-android_24_arm64_v8a")
        _wheel(self.wheels, "demo-a", "1.0", files={"chaquopy/lib/libother.so": "y", "demo_a/__init__.py": ""})
        self.install("demo-c", "demo-a")
        libs = sorted(os.listdir(os.path.join(self.pip.site_dir(), "chaquopy", "lib")))
        self.assertEqual(libs, ["libdemo.so", "libother.so"])

    def test_requirements_parsing(self):
        text = "# comment\nschedule==1.2.2\n\n-i https://mirror\npymysql>=1.0  # db\n"
        self.assertEqual(self.pip.parse_requirements(text), ["schedule==1.2.2", "pymysql>=1.0"])

    def test_ensure_project(self):
        _wheel(self.wheels, "demo-b", "2.1")
        proj = tempfile.mkdtemp()
        try:
            with open(os.path.join(proj, "requirements.txt"), "w") as f:
                f.write("demo-b\n")
            self.assertEqual(self.pip.missing(["demo-b"]), ["demo-b"])
            orig = self.pip.install
            self.pip.install = lambda *r, **k: orig(*r, target=self.target,
                                                     finder=_FakeFinder(self.wheels, self.target), log=lambda m: None)
            try:
                self.pip.ensure_project(proj, log=lambda m: None)
            finally:
                self.pip.install = orig
            self.assertEqual(self.pip.missing(["demo-b"]), [])
            self.assertIsNone(self.pip.ensure_project(proj, log=lambda m: None))
        finally:
            shutil.rmtree(proj)


if __name__ == "__main__":
    unittest.main()
