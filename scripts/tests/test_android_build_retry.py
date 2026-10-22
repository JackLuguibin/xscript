"""android/build.sh retries a build that failed in Chaquopy's pip install (chaquo.com unreachable), nothing else."""
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="bash script")


def run(tmp_path, script, retries="3"):
    (tmp_path / "android").mkdir()
    shutil.copy(ROOT / "android" / "build.sh", tmp_path / "android" / "build.sh")
    gradlew = tmp_path / "android" / "gradlew"
    gradlew.write_text("#!/usr/bin/env bash\n" + script)
    gradlew.chmod(0o755)
    env = dict(os.environ, XSCRIPT_BUILD_PYTHON=sys.executable, ANDROID_HOME=str(tmp_path), XSCRIPT_PIP_RETRIES=retries,
               XSCRIPT_PIP_RETRY_WAIT="0")
    r = subprocess.run(["bash", str(tmp_path / "android" / "build.sh"), "--console=plain"], env=env, capture_output=True, text=True)
    count = int((tmp_path / "android" / "n").read_text()) if (tmp_path / "android" / "n").exists() else 0
    return r, count


COUNT = 'n=$(( $(cat n 2>/dev/null || echo 0) + 1 )); echo $n > n\n'


def test_pip_install_failure_is_retried_until_it_passes(tmp_path):
    r, n = run(tmp_path, COUNT + 'if [ $n -lt 3 ]; then echo "> Task :app:installReleasePythonRequirements FAILED"; exit 1; fi\necho "args: $*"\n')
    assert r.returncode == 0, r.stderr
    assert n == 3
    assert "args: :app:assembleDebug --console=plain" in r.stdout
    assert "retry 2/3" in r.stderr and "retry 3/3" in r.stderr


def test_gives_up_after_the_last_attempt(tmp_path):
    r, n = run(tmp_path, COUNT + 'echo "> Task :app:installDebugPythonRequirements FAILED"; exit 1\n', retries="2")
    assert r.returncode == 1 and n == 2


def test_other_failures_are_not_retried(tmp_path):
    r, n = run(tmp_path, COUNT + 'echo "> Task :app:compileDebugKotlin FAILED"; exit 7\n')
    assert r.returncode == 7 and n == 1


def test_one_attempt_by_default_outside_ci(tmp_path):
    env_ci = os.environ.pop("CI", None)
    try:
        (tmp_path / "android").mkdir()
        shutil.copy(ROOT / "android" / "build.sh", tmp_path / "android" / "build.sh")
        g = tmp_path / "android" / "gradlew"
        g.write_text("#!/usr/bin/env bash\n" + COUNT + 'echo "> Task :app:installDebugPythonRequirements FAILED"; exit 1\n')
        g.chmod(0o755)
        env = {k: v for k, v in os.environ.items() if k not in ("CI", "XSCRIPT_PIP_RETRIES")}
        env.update(XSCRIPT_BUILD_PYTHON=sys.executable, ANDROID_HOME=str(tmp_path), XSCRIPT_PIP_RETRY_WAIT="0")
        r = subprocess.run(["bash", str(tmp_path / "android" / "build.sh")], env=env, capture_output=True, text=True)
        assert r.returncode == 1 and (tmp_path / "android" / "n").read_text().strip() == "1"
    finally:
        if env_ci is not None:
            os.environ["CI"] = env_ci
