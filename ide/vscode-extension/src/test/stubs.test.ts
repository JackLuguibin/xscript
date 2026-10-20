// The .pyi stubs shipped in the extension (copied by scripts/copy-stubs.js) expose the device APIs with the
// device's exact signatures, and no longer call implemented APIs "unsupported".
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const stub = (rel: string) => fs.readFileSync(path.resolve(__dirname, "..", "..", "stubs", rel), "utf-8");

test("ascript.android.media stubs: recording and e-mail", () => {
  const s = stub("ascript/android/media.pyi");
  for (const sig of ["def recode(path, time=None):", "def stop_recode():", "def recode_status():", "def send_email(to=None, subject=None, body=None, cc=None):"])
    assert.ok(s.includes(sig), sig);
  assert.match(s, /time: milliseconds/);
  assert.doesNotMatch(s, /not supported/i);
});

test("ascript.android.location stubs: mock location and coordinate conversion", () => {
  const s = stub("ascript/android/location.pyi");
  for (const sig of [
    "class MockLocationApi:",
    "def start(self, lon, lat, accuracy=5.0, interval=1000, coord_type='bd09'):",
    "def stop(self):",
    "def status(self):",
    "mock: MockLocationApi",
    "from xscript.android.coords import wgs84_to_gcj02, gcj02_to_wgs84, bd09_to_gcj02, gcj02_to_bd09, wgs84_to_bd09, bd09_to_wgs84, to_wgs84, from_wgs84, convert",
  ]) assert.ok(s.includes(sig), sig);
  assert.doesNotMatch(s, /unsupported/i);
  const c = stub("xscript/android/coords.pyi");
  for (const sig of [
    "def to_wgs84(lon, lat, coord_type='wgs84'):",
    "def from_wgs84(lon, lat, coord_type='gcj02'):",
    "def convert(lon, lat, from_type, to_type):",
    "def wgs84_to_gcj02(lon, lat):",
    "def gcj02_to_wgs84(lon, lat):",
    "def bd09_to_gcj02(lon, lat):",
    "def gcj02_to_bd09(lon, lat):",
    "def wgs84_to_bd09(lon, lat):",
    "def bd09_to_wgs84(lon, lat):",
  ]) assert.ok(c.includes(sig), sig);
});

test("ascript.android.plug stubs: APK / JAR plugins via DexClassLoader", () => {
  const s = stub("ascript/android/plug.pyi");
  for (const sig of ["def load_apk(path):", "def load_apk_dir(directory):", "class Plugin(object):", "def load_class(self, name):",
    "class JavaClass(object):", "def new(self, *args):", "def call_static(self, method, *args):", "class JavaObject(object):", "def call(self, method, *args):"])
    assert.ok(s.includes(sig), sig);
});

test("ascript.android.bluetooth stubs: scan, SPP and BLE GATT instead of the old 'not supported' module", () => {
  const s = stub("ascript/android/bluetooth.pyi");
  for (const sig of ["def scan(timeout=10, ble=False):", "def connect(address, uuid=None):", "def ble_connect(address, timeout=15):",
    "class Connection(object):", "def read(self, size=1024, timeout=1.0):", "class BleConnection(object):",
    "def write(self, service, char, data, no_response=False):", "def notify(self, service, char, callback=None):", "class BluetoothError(RuntimeError):"])
    assert.ok(s.includes(sig), sig);
  assert.doesNotMatch(s, /not supported|NotImplementedError/);
});

test("xscript.android.ime stubs: XScript 输入法 control", () => {
  const s = stub("xscript/android/ime.pyi");
  for (const sig of ["class ImeNotActive(RuntimeError):", "def status():", "def is_active():", "def switch():", "def restore():",
    "def commit(text):", "def set_text(text):", "def delete(before=1, after=0):", "def clear():", "def enter():", "def key(code):"])
    assert.ok(s.includes(sig), sig);
});

test("ascript.android.action.Ime stubs gain switch / restore / delete and drop the 'no custom IME' note", () => {
  const s = stub("ascript/android/action.pyi");
  const ime = s.slice(s.indexOf("class Ime"));
  for (const sig of ["def switch():", "def restore():", "def delete(count=1):"]) assert.ok(ime.includes(sig), sig);
  assert.doesNotMatch(s, /has no custom IME/);
});

test("ascript.android.screen.gp stubs: task registry and allow_python", () => {
  const s = stub("ascript/android/screen/gp.pyi");
  for (const sig of ["def register_task(task_id, task_class):", "def unregister_task(task_id):", "def run(gp_file, cv_img=None, allow_python=True):"])
    assert.ok(s.includes(sig), sig);
  assert.doesNotMatch(s, /deliberately not executed/);
});
