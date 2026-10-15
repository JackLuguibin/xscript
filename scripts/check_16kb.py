#!/usr/bin/env python3
"""Is an APK ready for 16 KB page-size devices?

usage: scripts/check_16kb.py app-release.apk [--strict]

Checks (1) zipalign -c -P 16 (uncompressed .so files must be 16 KB aligned in the zip), (2) the
ELF LOAD alignment (p_align >= 16384) of every .so: the APK's lib/*.so and the ones inside
Chaquopy's assets/chaquopy/*.imy archives (extracted to the app's files dir at run time), and
(3) the android:pageSizeCompat attribute in the manifest (aapt2 / aapt dump).

Native libraries that are only 4 KB aligned load on a 16 KB device only in Android's 16 KB
backcompat mode. Without --strict the script exits 0 when every 4 KB library is listed and the
manifest enables the compat mode; --strict fails on any 4 KB library.
"""
import glob, io, os, struct, subprocess, sys, zipfile

SDK = os.environ.get("ANDROID_HOME", os.path.expanduser("~/Library/Android/sdk"))


def tool(name):
    c = sorted(glob.glob(os.path.join(SDK, "build-tools", "*", name)))
    return c[-1] if c else None


def aligns(data):
    if data[:4] != b"\x7fELF" or data[4] != 2:
        return None
    phoff, = struct.unpack_from("<Q", data, 32)
    es, n = struct.unpack_from("<HH", data, 54)
    return [struct.unpack_from("<IIQQQQQQ", data, phoff + i * es)[7] for i in range(n)
            if struct.unpack_from("<I", data, phoff + i * es)[0] == 1]


def is_so(name):
    base = name.rsplit("/", 1)[-1]
    return base.endswith(".so") or ".so." in base


def scan(zf, prefix, out):
    for n in zf.namelist():
        if not is_so(n):
            continue
        a = aligns(zf.read(n))
        if a is not None:
            out.append((prefix + n, min(a) if a else 0))


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    apk, strict = sys.argv[1], "--strict" in sys.argv[2:]
    problems = []

    za = tool("zipalign")
    if za:
        r = subprocess.run([za, "-c", "-P", "16", "4", apk], capture_output=True, text=True)
        ok = r.returncode == 0
        print(("OK   " if ok else "BAD  ") + "zipalign -c -P 16 (uncompressed .so files are 16 KB aligned in the zip)")
        if not ok:
            problems.append("zip alignment")
    else:
        print("SKIP zipalign not found in the SDK build-tools")

    libs = []
    with zipfile.ZipFile(apk) as z:
        scan(z, "", libs)
        for n in z.namelist():
            if n.startswith("assets/chaquopy/") and n.endswith(".imy"):
                with zipfile.ZipFile(io.BytesIO(z.read(n))) as inner:
                    scan(inner, n.rsplit("/", 1)[-1] + ":", libs)
    bad = [(n, a) for n, a in libs if a < 16384]
    print("%s  ELF LOAD alignment: %d libraries, %d below 16 KB" % ("BAD " if bad else "OK  ", len(libs), len(bad)))
    own = [n for n, a in bad if n.startswith("lib/")]
    for n, a in bad:
        print("     %d  %s" % (a, n))
    if own:
        problems.append("the app's own lib/*.so below 16 KB: %s" % own)

    compat = None
    for t in (tool("aapt2"), tool("aapt")):
        if t:
            args = [t, "dump", "xmltree", "--file", "AndroidManifest.xml", apk] if t.endswith("aapt2") else \
                   [t, "dump", "xmltree", apk, "AndroidManifest.xml"]
            r = subprocess.run(args, capture_output=True, text=True)
            if r.returncode == 0:
                compat = "pageSizeCompat" in r.stdout
                break
    print("%s  manifest android:pageSizeCompat %s" % ("OK  " if compat else ("BAD " if compat is False else "SKIP"),
                                                       {True: "present", False: "missing", None: "(aapt not found)"}[compat]))
    if bad and not compat:
        problems.append("4 KB libraries without android:pageSizeCompat")
    if strict and bad:
        problems.append("--strict: 4 KB libraries present")
    print("16 KB READY" if not problems else "NOT READY: " + "; ".join(problems))
    sys.exit(1 if problems else 0)


main()
