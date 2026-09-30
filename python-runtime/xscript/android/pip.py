"""Install PyPI packages on the device at runtime (no APK rebuild).

    from xscript.android import pip
    pip.install("schedule", "pymysql==1.1.1")     # pure-Python wheels from PyPI
    pip.install("pandas")                          # Android builds from the Chaquopy index
    pip.install_requirements(R.root("requirements.txt"))
    pip.list()                                     # [{"name", "version", "location"}]
    pip.uninstall("schedule")

A project with a `requirements.txt` gets missing packages installed automatically before
`__init__.py` runs (only the first run needs the network).

Where packages come from:
  * Native packages (numpy-style C extensions) come from Chaquopy's Android wheel index
    (https://chaquo.com/pypi-13.1, ~140 packages: pandas, scipy, lxml, cryptography, ...).
    Their shared libraries are loaded from the install directory on import.
  * Everything else must have a pure-Python wheel (`py3-none-any`) on PyPI or the mirror
    given by `index_url`. Source-only packages cannot be built on the phone.
Packages already in the app (numpy, opencv, pillow, requests, pyyaml, ...) are never
replaced, so their compiled versions stay consistent.

Installs go to the app's private files directory (`site_dir()`), which is shared by the
script and eval processes and survives app updates.
"""

import email.parser
import hashlib
import json
import os
import re
import shutil
import tempfile
import time
import zipfile

_list = list  # the module defines list() (pip list) below

from xscript.runtime import sitepkgs

CHAQUOPY_INDEX = "https://chaquo.com/pypi-13.1/"
PYPI_INDEXES = ("https://pypi.org/simple/", "https://pypi.tuna.tsinghua.edu.cn/simple/")
PY_VERSION = (3, 10)

_WHEEL = re.compile(
    r"^(?P<name>[^-]+)-(?P<ver>[^-]+)(?:-(?P<build>\d[^-]*))?-(?P<py>[^-]+)-(?P<abi>[^-]+)-(?P<plat>[^-]+)\.whl$")


class PipError(RuntimeError):
    pass


def site_dir():
    return sitepkgs.site_dir()


def normalize(name):
    return re.sub(r"[-_.]+", "-", str(name)).lower()


def _packaging():
    try:
        from packaging.markers import default_environment  # noqa: F401
        from packaging.requirements import Requirement  # noqa: F401
        from packaging.specifiers import SpecifierSet  # noqa: F401
        from packaging.version import Version  # noqa: F401
        import packaging
        return packaging
    except ImportError:
        raise PipError("the `packaging` module is missing from this runtime")


# ---------------------------------------------------------------- target platform

class Target(object):
    """What wheels this device can use: Android API level, ABI, Python 3.10."""

    def __init__(self, api=None, abi=None):
        if api is None or abi is None:
            dev = sitepkgs.device()
            api = api if api is not None else int(dev.get("sdk") or 24)
            abi = abi if abi is not None else dev.get("abi") or "arm64-v8a"
        self.api = int(api)
        self.abi = str(abi).replace("-", "_")  # wheel tags use arm64_v8a

    def wheel_ok(self, filename):
        """True if the wheel can be installed here. Returns (ok, native)."""
        m = _WHEEL.match(filename)
        if not m:
            return False, False
        pys, abis, plats = m.group("py").split("."), m.group("abi").split("."), m.group("plat").split(".")
        py_ok = any(p in ("py3", "py2.py3", "cp310", "py310", "py30", "py31", "py32", "py33", "py34", "py35",
                          "py36", "py37", "py38", "py39") for p in pys)
        if "any" in plats:
            return py_ok and ("none" in abis), False
        for plat in plats:
            am = re.match(r"^android_(\d+)_(.+)$", plat)
            if not am or am.group(2) != self.abi or int(am.group(1)) > self.api:
                continue
            if "cp310" in abis or "abi3" in abis or ("none" in abis and py_ok):
                return True, True
        return False, False

    def environment(self):
        from packaging.markers import default_environment

        env = default_environment()
        env.update({
            "python_version": "%d.%d" % PY_VERSION,
            "python_full_version": "%d.%d.0" % PY_VERSION,
            "sys_platform": "linux",
            "platform_system": "Linux",
            "os_name": "posix",
            "platform_machine": "aarch64" if self.abi == "arm64_v8a" else self.abi,
            "implementation_name": "cpython",
            "platform_python_implementation": "CPython",
        })
        return env


# ---------------------------------------------------------------- indexes

def _http():
    import requests

    s = requests.Session()
    s.headers["User-Agent"] = "xscript-pip/1.0"
    return s


class Candidate(object):
    __slots__ = ("name", "version", "build", "filename", "url", "sha256", "native", "requires_python")

    def __init__(self, name, version, build, filename, url, sha256, native, requires_python):
        self.name, self.version, self.build = name, version, build
        self.filename, self.url, self.sha256 = filename, url, sha256
        self.native, self.requires_python = native, requires_python

    def __repr__(self):
        return "Candidate(%s %s %s)" % (self.name, self.version, self.filename)


class Finder(object):
    """Collects installable wheels for a project from the Chaquopy index and PyPI (JSON API)."""

    def __init__(self, target, index_url=None, timeout=30, session=None):
        self.target = target
        self.indexes = [index_url.rstrip("/") + "/"] if index_url else _list(PYPI_INDEXES)
        self.timeout = timeout
        self.session = session or _http()
        self._chaquopy_names = None

    def chaquopy_names(self):
        if self._chaquopy_names is None:
            try:
                r = self.session.get(CHAQUOPY_INDEX, timeout=self.timeout)
                r.raise_for_status()
                self._chaquopy_names = {normalize(n) for n in re.findall(r'href="([^"/:]+)/"', r.text)}
            except Exception:
                self._chaquopy_names = set()
        return self._chaquopy_names

    def candidates(self, name):
        from packaging.version import InvalidVersion, Version

        key = normalize(name)
        out = []
        if key in self.chaquopy_names():
            out.extend(self._chaquopy(key))
        out.extend(self._pypi(key))
        good = []
        for c in out:
            try:
                c.version = Version(str(c.version))
            except InvalidVersion:
                continue
            good.append(c)
        return good

    def _chaquopy(self, key):
        r = self.session.get(CHAQUOPY_INDEX + key + "/", timeout=self.timeout)
        if r.status_code == 404:
            return []
        r.raise_for_status()
        out = []
        for fn in set(re.findall(r'href="([^"]+\.whl)"', r.text)):
            fn = fn.rsplit("/", 1)[-1]
            ok, native = self.target.wheel_ok(fn)
            if not ok:
                continue
            m = _WHEEL.match(fn)
            out.append(Candidate(key, m.group("ver"), int(re.match(r"\d*", m.group("build") or "0").group() or 0),
                                 fn, CHAQUOPY_INDEX + key + "/" + fn, None, native, None))
        return out

    def _pypi(self, key):
        last = None
        for base in self.indexes:
            try:
                r = self.session.get(base + key + "/", timeout=self.timeout,
                                     headers={"Accept": "application/vnd.pypi.simple.v1+json"})
                if r.status_code == 404:
                    return []
                r.raise_for_status()
                data = r.json()
                break
            except Exception as e:  # next mirror
                last = e
        else:
            raise PipError("cannot reach the package index: %s" % last)
        out = []
        for f in data.get("files", []):
            fn = f.get("filename", "")
            if not fn.endswith(".whl") or f.get("yanked"):
                continue
            ok, native = self.target.wheel_ok(fn)
            if not ok:
                continue
            m = _WHEEL.match(fn)
            url = f.get("url", "")
            if url and not url.startswith("http"):
                url = base.rstrip("/") + "/" + key + "/" + url
            out.append(Candidate(key, m.group("ver"), 0, fn, url.split("#")[0],
                                 (f.get("hashes") or {}).get("sha256"), native, f.get("requires-python")))
        return out


# ---------------------------------------------------------------- installed distributions

def installed(include_builtin=True):
    """{normalized name: (version, location)} of every importable distribution."""
    from importlib import metadata

    out = {}
    site = os.path.abspath(site_dir())
    for d in metadata.distributions():
        name = d.metadata.get("Name")
        if not name:
            continue
        loc = str(getattr(d, "_path", "") or "")
        user = loc.startswith(site)
        if not include_builtin and not user:
            continue
        key = normalize(name)
        if key in out and not user:
            continue
        out[key] = (d.version, "user" if user else "builtin")
    return out


def list():  # noqa: A001 - pip-style name
    """Packages installed with pip.install (not the ones bundled in the app)."""
    return [{"name": k, "version": v, "location": loc} for k, (v, loc) in sorted(installed(False).items())]


# ---------------------------------------------------------------- resolve & install

def _wheel_metadata(path):
    with zipfile.ZipFile(path) as z:
        meta = [n for n in z.namelist() if re.match(r"^[^/]+\.dist-info/METADATA$", n)]
        if not meta:
            raise PipError("%s has no METADATA" % os.path.basename(path))
        return email.parser.Parser().parsestr(z.read(meta[0]).decode("utf-8", "replace"))


def _download(session, cand, cache, timeout):
    target = os.path.join(cache, cand.filename)
    if os.path.isfile(target) and (not cand.sha256 or _sha256(target) == cand.sha256):
        return target
    tmp = target + ".part"
    h = hashlib.sha256()
    with session.get(cand.url, stream=True, timeout=timeout) as r:
        r.raise_for_status()
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(1 << 16):
                f.write(chunk)
                h.update(chunk)
    if cand.sha256 and h.hexdigest() != cand.sha256:
        os.remove(tmp)
        raise PipError("checksum mismatch for %s" % cand.filename)
    os.replace(tmp, target)
    return target


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class Plan(object):
    def __init__(self):
        self.chosen = {}     # key -> (Candidate, wheel path)
        self.skipped = {}    # key -> reason ("builtin 1.23.3", "installed 1.2")
        self.order = []


def resolve(requirements, target=None, index_url=None, upgrade=False, finder=None, log=print, timeout=60):
    """Pick and download wheels for `requirements` and their dependencies (depth-first)."""
    _packaging()
    from packaging.requirements import Requirement

    target = target or Target()
    finder = finder or Finder(target, index_url)
    env = target.environment()
    have = installed()
    cache = os.path.join(sitepkgs.pip_home(), "cache")
    os.makedirs(cache, exist_ok=True)
    plan = Plan()
    py = "%d.%d" % PY_VERSION

    def visit(req, top, extras_env=None):
        if req.marker is not None and not req.marker.evaluate(dict(env, **(extras_env or {"extra": ""}))):
            return
        key = normalize(req.name)
        if key in plan.chosen:
            cand = plan.chosen[key][0]
            if req.specifier and not req.specifier.contains(cand.version, prereleases=True):
                raise PipError("conflict: %s needs %s%s, already picked %s" % (req, key, req.specifier, cand.version))
            return
        if key in have:
            ver, where = have[key]
            builtin = where == "builtin"
            satisfied = not req.specifier or req.specifier.contains(ver, prereleases=True)
            if builtin:
                if not satisfied:
                    log("xscript-pip: %s %s is built into the app; %s cannot be replaced" % (key, ver, req))
                plan.skipped[key] = "builtin %s" % ver
                return
            if satisfied and not (upgrade and top):
                plan.skipped[key] = "installed %s" % ver
                return
        # Pre-releases only when the requirement itself names one (pip's default).
        pre = any(_is_pre(s.version) for s in req.specifier)
        cands = [c for c in finder.candidates(key)
                 if (pre or not c.version.is_prerelease)
                 and (not req.specifier or req.specifier.contains(c.version, prereleases=True))
                 and (not c.requires_python or _py_ok(c.requires_python, py))]
        if not cands:
            raise PipError("no Android-compatible wheel for %s (source-only or native packages outside the "
                           "Chaquopy index cannot be installed on the device)" % req)
        cands.sort(key=lambda c: (c.version, c.native, c.build), reverse=True)
        cand = cands[0]
        log("xscript-pip: downloading %s" % cand.filename)
        path = _download(finder.session, cand, cache, timeout)
        plan.chosen[key] = (cand, path)
        meta = _wheel_metadata(path)
        if meta.get("Requires-Python") and not _py_ok(meta["Requires-Python"], py):
            raise PipError("%s %s needs Python %s" % (key, cand.version, meta["Requires-Python"]))
        for dep in meta.get_all("Requires-Dist") or []:
            sub = Requirement(dep)
            for extra in (req.extras or [""]):
                if sub.marker is None or sub.marker.evaluate(dict(env, extra=extra)):
                    visit(Requirement(str(sub).split(";")[0]), False)
                    break
        plan.order.append(key)

    for r in requirements:
        visit(Requirement(r) if isinstance(r, str) else r, True)
    return plan


def _py_ok(spec, py):
    from packaging.specifiers import InvalidSpecifier, SpecifierSet

    try:
        return SpecifierSet(spec).contains(py)
    except InvalidSpecifier:
        return True  # malformed metadata on old uploads; let the install decide


def _is_pre(v):
    from packaging.version import Version

    try:
        return Version(v).is_prerelease
    except Exception:
        return False


def _unpack(wheel, site):
    """Install one wheel into `site` via a staging dir, so a crash never leaves half a package."""
    staging = tempfile.mkdtemp(prefix=".staging-", dir=site)
    try:
        with zipfile.ZipFile(wheel) as z:
            for info in z.infolist():
                name = info.filename
                if name.endswith("/") or ".." in name.split("/") or name.startswith("/"):
                    continue
                # <dist>.data/{purelib,platlib}/x → x; scripts / headers / data are not needed here.
                m = re.match(r"^[^/]+\.data/(purelib|platlib)/(.+)$", name)
                if m:
                    name = m.group(2)
                elif re.match(r"^[^/]+\.data/", name):
                    continue
                out = os.path.join(staging, name)
                os.makedirs(os.path.dirname(out), exist_ok=True)
                with z.open(info) as src, open(out, "wb") as dst:
                    shutil.copyfileobj(src, dst)
        for entry in os.listdir(staging):
            src, dst = os.path.join(staging, entry), os.path.join(site, entry)
            if os.path.isdir(src) and os.path.isdir(dst) and not entry.endswith(".dist-info"):
                _merge(src, dst)  # shared trees such as chaquopy/lib or namespace packages
            else:
                if os.path.isdir(dst):
                    shutil.rmtree(dst)
                elif os.path.exists(dst):
                    os.remove(dst)
                os.replace(src, dst)
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def _merge(src, dst):
    for root, _dirs, files in os.walk(src):
        rel = os.path.relpath(root, src)
        os.makedirs(os.path.join(dst, rel), exist_ok=True)
        for f in files:
            os.replace(os.path.join(root, f), os.path.join(dst, rel, f))


def _remove_dist(key, site):
    """Delete an installed distribution using its RECORD."""
    for entry in os.listdir(site):
        if not entry.endswith(".dist-info"):
            continue
        meta_file = os.path.join(site, entry, "METADATA")
        try:
            with open(meta_file, "r", encoding="utf-8", errors="replace") as f:
                name = email.parser.Parser().parse(f).get("Name", "")
        except OSError:
            continue
        if normalize(name) != key:
            continue
        record = os.path.join(site, entry, "RECORD")
        dirs = set()
        if os.path.isfile(record):
            with open(record, "r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    rel = line.split(",", 1)[0].strip()
                    m = re.match(r"^[^/]+\.data/(purelib|platlib)/(.+)$", rel)
                    if m:
                        rel = m.group(2)
                    if not rel or ".." in rel.split("/"):
                        continue
                    p = os.path.join(site, rel)
                    if os.path.isfile(p):
                        os.remove(p)
                        dirs.add(os.path.dirname(p))
        shutil.rmtree(os.path.join(site, entry), ignore_errors=True)
        for d in sorted(dirs, key=len, reverse=True):
            _prune(d, site)
        return True
    return False


def _prune(d, site):
    site = os.path.abspath(site)
    d = os.path.abspath(d)
    while d.startswith(site + os.sep):
        cache = os.path.join(d, "__pycache__")
        if os.path.isdir(cache):
            shutil.rmtree(cache, ignore_errors=True)
        try:
            os.rmdir(d)
        except OSError:
            return
        d = os.path.dirname(d)


def install(*packages, index_url=None, upgrade=False, log=print, target=None, finder=None):
    """Install requirement strings ("name", "name==1.2", "name[extra]>=2"). Returns a summary dict.

    Already-installed packages that satisfy the request are left alone unless upgrade=True.
    """
    reqs = [p for p in packages if p and str(p).strip()]
    if not reqs:
        return {"installed": [], "skipped": {}}
    started = time.time()
    site = site_dir()
    os.makedirs(site, exist_ok=True)
    with sitepkgs.lock():
        plan = resolve(reqs, target=target, index_url=index_url, upgrade=upgrade, finder=finder, log=log)
        done = []
        for key in plan.order:
            cand, wheel = plan.chosen[key]
            _remove_dist(key, site)
            _unpack(wheel, site)
            done.append({"name": key, "version": str(cand.version), "native": cand.native})
            log("xscript-pip: installed %s %s" % (key, cand.version))
    sitepkgs.activate(refresh=True)
    return {"installed": done, "skipped": plan.skipped, "ms": int((time.time() - started) * 1000)}


def uninstall(*names, log=print):
    site = site_dir()
    removed = []
    with sitepkgs.lock():
        for n in names:
            key = normalize(n)
            if _remove_dist(key, site):
                removed.append(key)
                log("xscript-pip: removed %s" % key)
    sitepkgs.activate(refresh=True)
    return {"removed": removed}


def parse_requirements(text):
    """requirements.txt lines → requirement strings (comments, blanks and pip options skipped)."""
    out = []
    for line in text.splitlines():
        line = line.split(" #", 1)[0].strip()
        if not line or line.startswith("#") or line.startswith("-"):
            continue
        out.append(line)
    return out


def install_requirements(path, index_url=None, log=print):
    with open(path, "r", encoding="utf-8") as f:
        return install(*parse_requirements(f.read()), index_url=index_url, log=log)


def missing(requirements):
    """Requirement strings not satisfied by what is installed now."""
    from packaging.requirements import Requirement

    have = installed()
    env = Target().environment() if sitepkgs.on_device() else None
    out = []
    for r in requirements:
        req = Requirement(r)
        if req.marker is not None and env is not None and not req.marker.evaluate(env):
            continue
        cur = have.get(normalize(req.name))
        if cur is None or (req.specifier and not req.specifier.contains(cur[0], prereleases=True)):
            out.append(r)
    return out


def ensure_project(project_dir, log=print):
    """Before a run: install the project's requirements.txt entries that are missing."""
    path = os.path.join(project_dir, "requirements.txt")
    if not os.path.isfile(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        reqs = parse_requirements(f.read())
    need = missing(reqs)
    if not need:
        return None
    log("xscript-pip: installing requirements: %s" % ", ".join(need))
    return install(*need, log=log)


def run_request(req):
    """HTTP / MCP entry (runs in :eval): {"op": "install"|"uninstall"|"list", ...} → dict."""
    op = req.get("op", "list")
    lines = []

    def log(msg):
        lines.append(msg)

    if op == "install":
        out = install(*req.get("packages", []), index_url=req.get("index_url") or None,
                      upgrade=bool(req.get("upgrade")), log=log)
    elif op == "uninstall":
        out = uninstall(*req.get("packages", []), log=log)
    elif op == "list":
        out = {"packages": list()}
    else:
        raise ValueError("unknown pip op %r" % op)
    out["log"] = lines
    return out


def run_b64(payload):
    import base64

    return run_request(json.loads(base64.b64decode(payload).decode("utf-8")))

