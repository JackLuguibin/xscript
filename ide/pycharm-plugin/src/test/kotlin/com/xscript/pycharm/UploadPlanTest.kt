package com.xscript.pycharm

import org.junit.Assert.assertEquals
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
}
