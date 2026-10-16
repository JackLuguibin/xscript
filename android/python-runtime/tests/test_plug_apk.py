"""plug.load_apk reflection wrappers against a fake Plugins object (the real one is Kotlin, reached through Chaquopy)."""
import sys
import types
import unittest
from unittest.mock import patch

from ascript.android import plug


class IllegalArgumentException(Exception):
    def getMessage(self):
        return self.args[0]


class FakeClass:
    def __init__(self, name):
        self.name = name

    def getName(self):
        return self.name


class FakeObj:
    def __init__(self, cls, args):
        self.cls, self.args, self.fields = cls, args, {}

    def getClass(self):
        return self.cls

    def toString(self):
        return "Obj%s" % (list(self.args),)


class FakePlugins:
    def __init__(self):
        self.calls = []
        self.statics = {"VERSION": "1.0"}

    def load(self, path):
        self.calls.append(("load", path))
        if not path.endswith(".jar"):
            raise IllegalArgumentException("plugins must be .apk, .jar, .dex or .zip")
        return "abc123"

    def loadClass(self, pid, name):
        self.calls.append(("loadClass", pid, name))
        return FakeClass(name)

    def newInstance(self, cls, args):
        return FakeObj(cls, args)

    def invoke(self, cls, target, name, args):
        self.calls.append(("invoke", cls.name, target is not None, name, list(args)))
        if name == "child":
            return FakeObj(cls, ["child"])
        return "%s(%s)" % (name, ",".join(map(str, args)))

    def getField(self, cls, target, name):
        return target.fields.get(name) if target is not None else self.statics[name]

    def setField(self, cls, target, name, value):
        (target.fields if target is not None else self.statics)[name] = value


class LoadApkTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakePlugins()
        java = types.ModuleType("java")
        java.jclass = lambda name: object
        java.jarray = lambda t: (lambda items: list(items))
        for p in (patch.object(plug, "_plugins", lambda: self.fake), patch.dict(sys.modules, {"java": java})):
            p.start()
            self.addCleanup(p.stop)

    def test_load_class_new_call_fields(self):
        lib = plug.load_apk("/data/files/libs/sdk.jar")
        self.assertEqual(lib.id, "abc123")
        Sdk = lib.load_class("com.example.Sdk")
        self.assertIs(lib["com.example.Sdk"], Sdk)  # cached
        sdk = Sdk.new("key", 3)
        self.assertEqual(sdk.java.args, ["key", 3])
        self.assertEqual(sdk.call("add", 1, 2.5), "add(1,2.5)")
        self.assertEqual(Sdk.call_static("hello", "x"), "hello(x)")
        self.assertEqual(self.fake.calls[-1], ("invoke", "com.example.Sdk", False, "hello", ["x"]))
        child = sdk.call("child")
        self.assertIsInstance(child, plug.JavaObject)
        sdk.call("use", child)  # wrappers are unwrapped to the Java object
        self.assertIs(self.fake.calls[-1][4][0], child.java)
        sdk.set("label", "y")
        self.assertEqual(sdk.get("label"), "y")
        self.assertEqual(Sdk.get_static("VERSION"), "1.0")
        Sdk.set_static("VERSION", "2.0")
        self.assertEqual(Sdk.get_static("VERSION"), "2.0")
        self.assertEqual(str(sdk), "Obj['key', 3]")

    def test_path_policy_errors_become_value_error(self):
        with self.assertRaises(ValueError) as cm:
            plug.load_apk("/data/files/libs/readme.txt")
        self.assertIn(".jar", str(cm.exception))

    def test_load_apk_dir(self):
        with patch("os.listdir", return_value=["b.jar", "a.jar", "notes.txt"]):
            libs = plug.load_apk_dir("/data/files/libs")
        self.assertEqual(list(libs), ["a.jar", "b.jar"])

    def test_inject_still_unsupported(self):
        with self.assertRaises(NotImplementedError):
            plug.inject()


if __name__ == "__main__":
    unittest.main()
