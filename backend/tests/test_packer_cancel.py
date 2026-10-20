"""Pack job cancel in the gap between "running" and the build process starting (no server needed)."""

from __future__ import annotations

import asyncio
import io
import sys
import tempfile
import threading
import time
import unittest
import zipfile
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import pgtest  # noqa: E402

pgtest.install()

from xscript_server import packer as packermod  # noqa: E402
from xscript_server.config import Config  # noqa: E402
from xscript_server.db import Database  # noqa: E402
from xscript_server.models import PackJob  # noqa: E402


class CancelBeforeSpawn(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        tmp = Path(tempfile.mkdtemp())
        (tmp / "data").mkdir()
        self.cfg = Config.load(str(tmp / "data"))
        script = tmp / "fake_pack.py"
        script.write_text("import time\ntime.sleep(30)\n")  # a build that only ends by being terminated
        self.cfg.pack_script = script
        self.db = Database(self.cfg.db_url)
        self.db.create_all()
        self.packer = packermod.Packer(self.cfg, self.db)
        with self.db.session() as s:
            job = PackJob(app_id="com.example.slow", app_name="慢", version="1.0", version_code=1, project_name="demo",
                          options={}, created_by="t", created_at=int(time.time()))
            s.add(job)
            s.commit()
            self.job_id = job.id
        d = self.packer.job_dir(self.job_id)
        d.mkdir(parents=True)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("demo/__init__.py", "")
        (d / "project.zip").write_bytes(buf.getvalue())

    def status(self) -> str:
        with self.db.session() as s:
            return s.get(PackJob, self.job_id).status

    async def run_with_cancel_during(self, gap: str) -> None:
        """Cancel while the job is "running" but `gap` has not finished, then let it continue."""
        entered, release = threading.Event(), threading.Event()
        real_extract, real_spawn = packermod.safe_extract, asyncio.create_subprocess_exec

        def slow_extract(*a, **k):
            entered.set()
            release.wait(5)
            return real_extract(*a, **k)

        async def slow_spawn(*a, **k):
            entered.set()
            proc = await real_spawn(*a, **k)
            await asyncio.get_running_loop().run_in_executor(None, release.wait, 5)
            return proc

        patch = (mock.patch.object(packermod, "safe_extract", slow_extract) if gap == "extract"
                 else mock.patch.object(packermod.asyncio, "create_subprocess_exec", slow_spawn))
        with patch:
            task = asyncio.create_task(self.packer._run(self.job_id))
            await asyncio.get_running_loop().run_in_executor(None, entered.wait, 5)
            self.assertEqual(self.status(), "running")
            self.assertTrue(await self.packer.cancel(self.job_id))
            release.set()
            started = time.monotonic()
            await asyncio.wait_for(task, 10)  # before the fix: the 30 s build ran to the end
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(self.status(), "cancelled")
        self.assertNotIn(self.job_id, self.packer.cancelled)

    async def test_cancel_while_the_sources_are_unpacked(self):
        await self.run_with_cancel_during("extract")
        self.assertIn("cancelled", self.packer.log_path(self.job_id).read_text())
        self.assertFalse((self.packer.job_dir(self.job_id) / "out").exists())

    async def test_cancel_while_the_build_process_is_starting(self):
        await self.run_with_cancel_during("spawn")


if __name__ == "__main__":
    unittest.main()
