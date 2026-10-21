package com.xscript.pycharm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

/** Same rules as the VS Code extension's planUpload (sync.ts). */
class UploadPlanTest {
    private val a = UploadFile("__init__.py", "print('hi')\n", "utf-8")
    private val b = UploadFile("res/x.bin", Base64.getEncoder().encodeToString(byteArrayOf(1, 2, 3)), "base64")
    private val c = UploadFile("中文.py", "x = '你好'\n", "utf-8")

    private fun remoteOf(vararg f: UploadFile) = f.map { RemoteFile(it.path, UploadPlanner.bytes(it).size.toLong()) }

    @Test fun firstUploadAndMissingProjectSendEverything() {
        val first = UploadPlanner.plan(listOf(a, b, c), null, emptyMap())
        assertEquals(3, first.upload.size)
        assertEquals(0, first.skipped)
        assertEquals("da39a3ee5e6b4b0d3255bfef95601890afd80709", UploadPlanner.sha1(ByteArray(0)))
        // project exists but was never uploaded from here: no cache, so everything goes
        assertEquals(3, UploadPlanner.plan(listOf(a, b, c), remoteOf(a, b, c), emptyMap()).upload.size)
    }

    @Test fun unchangedFilesAreSkippedChangedOnesSent() {
        val cache = UploadPlanner.plan(listOf(a, b, c), null, emptyMap()).hashes
        val same = UploadPlanner.plan(listOf(a, b, c), remoteOf(a, b, c), cache)
        assertEquals(emptyList<UploadFile>(), same.upload)
        assertEquals(3, same.skipped)

        val a2 = a.copy(content = "print('bye')\n")
        val changed = UploadPlanner.plan(listOf(a2, b, c), remoteOf(a, b, c), cache)
        assertEquals(listOf("__init__.py"), changed.upload.map { it.path })
        assertEquals(2, changed.skipped)
        assertEquals(UploadPlanner.sha1(UploadPlanner.bytes(a2)), changed.hashes["__init__.py"])
    }

    @Test fun deviceSideChangesAndMissingFilesAreResent() {
        val cache = UploadPlanner.plan(listOf(a, b, c), null, emptyMap()).hashes
        // the phone edited b (different size) and lost c
        val remote = listOf(RemoteFile(a.path, UploadPlanner.bytes(a).size.toLong()), RemoteFile(b.path, 99))
        assertEquals(listOf("res/x.bin", "中文.py"), UploadPlanner.plan(listOf(a, b, c), remote, cache).upload.map { it.path })
    }

    @Test fun cacheKeyIsPerDeviceAndProject() {
        assertEquals("xscript.sync:10.0.0.2:9860:demo", UploadPlanner.cacheKey(DeviceTarget("10.0.0.2", 9860), "demo"))
    }

    @Test fun deletesOnlyManagedDeviceFilesMissingLocally() {
        val ignore = IgnoreRules("*.log\ndata/\n")
        val remote = listOf("__init__.py", "old.py", "lib/gone.py", "lib/keep.py", "run.log", "data/cache.json",
            ".hidden", "__pycache__/x.pyc", "lib/__pycache__/y.pyc", "stale.pyc", "zz.txt").map { RemoteFile(it, 1L) }
        val local = listOf("lib/keep.py", "build.as")
        val gone = UploadPlanner.planDeletes(local, remote) { LocalProject.isSyncedPath(it, ignore) }
        // __init__.py is protected; .syncignore'd, dot, __pycache__ and .pyc paths are never managed by uploads
        assertEquals(listOf("lib/gone.py", "old.py", "zz.txt"), gone)
        assertEquals(emptyList<String>(), UploadPlanner.planDeletes(local, null) { true })
        assertEquals(emptyList<String>(), UploadPlanner.planDeletes(remote.map { it.path }, remote) { true })
    }

    @Test fun syncedPathFollowsCollectFilesRules() {
        val ignore = IgnoreRules("/build/\n*.log\n!keep.log\n")
        assertTrue(LocalProject.isSyncedPath("a/b.py", ignore))
        assertFalse(LocalProject.isSyncedPath("build/out.py", ignore))
        assertTrue(LocalProject.isSyncedPath("src/build/out.py", ignore))   // anchored rule
        assertFalse(LocalProject.isSyncedPath("venv/x.py", ignore))
        assertFalse(LocalProject.isSyncedPath("a/.git/x", ignore))
        assertFalse(LocalProject.isSyncedPath("x.pyo", ignore))
        assertFalse(LocalProject.isSyncedPath("a//b.py", ignore))
        assertFalse(LocalProject.isSyncedPath("x.log", ignore))
        assertTrue(LocalProject.isSyncedPath("keep.log", ignore))
    }

    @Test fun syncDeletesIsOffByDefault() = assertFalse(XScriptSettings.State().syncDeletes)

    @Test fun deleteListIsCapped() {
        val paths = (1..33).map { "f$it.py" }
        val text = UploadPlanner.describeDeletes(paths, max = 30) { "+$it" }
        assertEquals(31, text.lines().size)
        assertEquals("  f1.py", text.lines().first())
        assertEquals("  +3", text.lines().last())
        assertEquals("  a.py\n  b.py", UploadPlanner.describeDeletes(listOf("a.py", "b.py")))
    }

    @Test
    fun emptiedFoldersAreTheTopmostOnesTheDeletesLeaveWithoutFiles() {
        val remote = listOf("__init__.py", "lib/a.py", "lib/sub/b.py", "lib/__pycache__/a.pyc", "pkg/x.py", "pkg/data.json",
            "tools/t.py", "fresh/old.py", "assets/hidden/.keep", "assets/hidden/i.py").map { RemoteFile(it, 1L) }
        val gone = listOf("lib/a.py", "lib/sub/b.py", "pkg/x.py", "tools/t.py", "fresh/old.py", "assets/hidden/i.py")
        val local = listOf("__init__.py", "fresh/new.py")
        // lib: only __pycache__ is left (removed once, not lib/sub too); pkg keeps data.json; fresh has a file
        // just uploaded; assets/hidden keeps a dot file.
        assertEquals(listOf("lib", "tools"), UploadPlanner.planEmptiedFolders(local, remote, gone))
        assertEquals(emptyList<String>(), UploadPlanner.planEmptiedFolders(local, remote, emptyList()))
        assertEquals(emptyList<String>(), UploadPlanner.planEmptiedFolders(local, null, gone))
    }
}
