"""End-to-end check of the desktop auto-update on this Mac, without a real release (P5.4).

  desktop/app/.venv/bin/python scripts/desktop_update_e2e.py [--keep]

1. builds XScript.app + dmg of the current version (packaging/build_macos_app.sh, build_macos_dmg.sh) and of a test
   version X.Y.(Z+1)-dev1 from a temporary detached git worktree of HEAD (removed afterwards; commit first),
2. checks both dmgs really open (packaging/check_macos_dmg.sh),
3. installs the old app into a temp "Applications" folder (never /Applications), serves a local feed signed with a
   throwaway Ed25519 key (packaging/make_update_feed.py) on 127.0.0.1,
4. negative: the old app with a different trusted key refuses the feed and stays as it is,
5. runs the old app with --update-now: it downloads, verifies, stages, quits; the helper swaps the bundle and relaunches,
6. checks the bundle now is the new version (signature, Info.plist), the relaunched app runs, then stops it and runs the
   new bundle's --selftest.
Every launch uses a temp --data-dir; the installed /Applications/XScript.app and the user's profile are not touched.
"""
from __future__ import annotations

import argparse
import functools
import http.server
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "desktop" / "app"
FRONT = ROOT / "desktop" / "frontend"


def sh(cmd, **kw):
    print("$", " ".join(str(c) for c in cmd), flush=True)
    return subprocess.run([str(c) for c in cmd], check=True, **kw)


def version_of(app_dir: Path) -> str:
    return re.search(r'^version = "(.*)"', (app_dir / "pyproject.toml").read_text(), re.M).group(1)


def build(app_dir: Path) -> Path:
    log = app_dir / "build-e2e.log"
    with open(log, "w") as f:
        r = subprocess.run(["bash", str(app_dir / "packaging" / "build_macos_app.sh")], stdout=f, stderr=subprocess.STDOUT)
        if r.returncode == 0:
            r = subprocess.run(["bash", str(app_dir / "packaging" / "build_macos_dmg.sh")], stdout=f, stderr=subprocess.STDOUT)
    if r.returncode != 0:
        print(log.read_text()[-3000:], file=sys.stderr)
        sys.exit("build failed, see %s" % log)
    dmg = app_dir / "dist" / ("xscript-desktop-v%s-macos-arm64.dmg" % version_of(app_dir))
    assert dmg.is_file(), dmg
    return dmg


def copy_tree(dst: Path, new_version: str) -> Path:
    """A detached git worktree of HEAD (the frontend imports files from the repo root), with the test version."""
    sh(["git", "-C", ROOT, "worktree", "add", "--detach", "--quiet", dst, "HEAD"])
    (dst / "desktop" / "frontend" / "node_modules").symlink_to((FRONT / "node_modules").resolve())
    app = dst / "desktop" / "app"
    old = version_of(app)
    for f, pat in ((app / "pyproject.toml", 'version = "%s"'), (app / "xscript_desktop" / "__init__.py", '__version__ = "%s"')):
        s = f.read_text()
        assert (pat % old) in s, f
        f.write_text(s.replace(pat % old, pat % new_version, 1))
    return app


def drop_tree(dst: Path) -> None:
    if dst.exists():
        (dst / "desktop" / "frontend" / "node_modules").unlink(missing_ok=True)
        subprocess.run(["git", "-C", str(ROOT), "worktree", "remove", "--force", str(dst)], check=False)


def app_pids(bundle: Path) -> list[int]:
    r = subprocess.run(["pgrep", "-f", "^%s/Contents/MacOS/XScript" % bundle], capture_output=True, text=True)
    return [int(p) for p in r.stdout.split()]


def plist(bundle: Path, key: str) -> str:
    return subprocess.run(["/usr/libexec/PlistBuddy", "-c", "Print :" + key, str(bundle / "Contents" / "Info.plist")],
                          capture_output=True, text=True, check=True).stdout.strip()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--keep", action="store_true", help="keep the temp folder (dmgs, feed, logs)")
    ap.add_argument("--reuse-old", type=Path, help="use this already built dmg of the current version")
    a = ap.parse_args()
    if sys.platform != "darwin":
        sys.exit("macOS only")
    py = sys.executable
    old_v = version_of(APP)
    major, minor, patch = (int(x) for x in old_v.split("-")[0].split("."))
    new_v = "%d.%d.%d-dev1" % (major, minor, patch + 1)  # valid PEP 440 (pip) and newer than old_v for the updater
    tmp = Path(tempfile.mkdtemp(prefix="xscript-update-e2e-")).resolve()
    print("work folder:", tmp)
    checks: list[str] = []
    srv = None
    bundle = tmp / "Applications" / "XScript.app"
    try:
        old_dmg = a.reuse_old or build(APP)
        new_dmg = build(copy_tree(tmp / "src", new_v))
        for dmg, v in ((old_dmg, old_v), (new_dmg, new_v)):
            sh(["bash", APP / "packaging" / "check_macos_dmg.sh", dmg, v], stdout=subprocess.DEVNULL)
        checks.append("both dmgs open (direct + LaunchServices selftest): %s, %s" % (old_v, new_v))

        mnt = tmp / "mnt"
        mnt.mkdir()
        sh(["hdiutil", "attach", "-nobrowse", "-readonly", "-mountpoint", mnt, old_dmg], stdout=subprocess.DEVNULL)
        try:
            bundle.parent.mkdir()
            sh(["ditto", mnt / "XScript.app", bundle])
        finally:
            sh(["hdiutil", "detach", "-quiet", mnt])
        assert plist(bundle, "CFBundleShortVersionString") == old_v

        feed = tmp / "feed"
        feed.mkdir()
        shutil.copy2(new_dmg, feed / new_dmg.name)
        pub = subprocess.run([py, APP / "packaging" / "make_update_feed.py", "--new-key", tmp / "update.key"],
                             capture_output=True, text=True, check=True).stdout.strip()
        sh([py, APP / "packaging" / "make_update_feed.py", feed, feed / new_dmg.name, "--version", new_v,
            "--key", tmp / "update.key", "--notes-zh", "端到端测试版本", "--notes-en", "end-to-end test build"])
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(feed))  # logs each request
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        url = "http://127.0.0.1:%d/desktop-update.json" % srv.server_port
        exe = bundle / "Contents" / "MacOS" / "XScript"
        env = dict(os.environ, QT_QPA_PLATFORM="offscreen", QTWEBENGINE_CHROMIUM_FLAGS="--disable-gpu",
                   XSCRIPT_UPDATE_FEED=url)

        other = subprocess.run([py, APP / "packaging" / "make_update_feed.py", "--new-key", tmp / "other.key"],
                               capture_output=True, text=True, check=True).stdout.strip()
        r = subprocess.run([exe, "--update-now", "--data-dir", tmp / "data-neg"], env=dict(env, XSCRIPT_UPDATE_PUBKEY=other),
                           capture_output=True, text=True, timeout=180)
        assert r.returncode == 1 and '"kind": "signature"' in r.stderr, r.stderr[-2000:]
        assert plist(bundle, "CFBundleShortVersionString") == old_v and not (tmp / "data-neg" / "updates").exists()
        checks.append("a feed signed by another key is refused; nothing downloaded, app unchanged")

        data = tmp / "data"
        r = subprocess.run([exe, "--update-now", "--data-dir", data], env=dict(env, XSCRIPT_UPDATE_PUBKEY=pub),
                           capture_output=True, text=True, timeout=600)
        print(r.stdout[-1500:])
        assert r.returncode == 0 and "update install: installing" in r.stdout, r.stderr[-3000:]
        checks.append("old app: check → download → sha256 → staged (signature, bundle id, version) → quit, exit 0")
        log = data / "updates" / "update-helper.log"
        for _ in range(120):
            if log.exists() and "relaunched" in log.read_text():
                break
            time.sleep(0.5)
        print("helper log:\n" + log.read_text())
        assert "replaced" in log.read_text() and "relaunched" in log.read_text()
        assert plist(bundle, "CFBundleShortVersionString") == new_v
        sh(["codesign", "--verify", "--deep", "--strict", bundle])
        assert sorted(p.name for p in bundle.parent.iterdir()) == ["XScript.app"], list(bundle.parent.iterdir())
        checks.append("helper swapped the bundle: Info.plist %s, signature deep+strict ok, no leftovers" % new_v)
        pids = []
        for _ in range(40):
            pids = app_pids(bundle)
            if pids:
                break
            time.sleep(0.5)
        assert pids, "the new app was not relaunched"
        time.sleep(5)
        assert all(_alive(p) for p in pids), "the relaunched app exited"
        ps = subprocess.run(["ps", "-o", "args=", "-p", str(pids[0])], capture_output=True, text=True).stdout.strip()
        assert "--data-dir %s" % data in ps, ps
        checks.append("relaunched as %s with the same --data-dir (pid %d), still running after 5 s" % (new_v, pids[0]))
        for p in pids:
            os.kill(p, signal.SIGTERM)
        for _ in range(20):
            if not app_pids(bundle):
                break
            time.sleep(0.5)
        for p in app_pids(bundle):
            os.kill(p, signal.SIGKILL)
        rep = tmp / "selftest.json"
        sh([exe, "--selftest", "--timeout", "90", "--data-dir", tmp / "data-st", "--report", rep], env=env,
           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        st = json.loads(rep.read_text())
        assert st["selftest"] == "ok" and st["version"] == new_v, st
        checks.append("updated bundle --selftest: %s" % json.dumps(st))
        print("\nPASS (%d checks)" % len(checks))
        for c in checks:
            print("  ✓", c)
        return 0
    finally:
        if srv:
            srv.shutdown()
        for p in app_pids(bundle):
            os.kill(p, signal.SIGKILL)
        drop_tree(tmp / "src")  # a git worktree: always removed, also with --keep
        if a.keep:
            print("kept", tmp)
        else:
            shutil.rmtree(tmp, ignore_errors=True)


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


if __name__ == "__main__":
    raise SystemExit(main())
