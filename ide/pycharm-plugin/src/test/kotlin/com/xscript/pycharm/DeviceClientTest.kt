package com.xscript.pycharm

import org.junit.AfterClass
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.BeforeClass
import org.junit.Test
import java.io.File
import java.util.Base64

/** Runs DeviceClient against scripts/mock_device.py (the mock the VS Code and MCP tests use). */
class DeviceClientTest {
    companion object {
        private val procs = mutableListOf<Process>()
        private lateinit var open: DeviceClient
        private lateinit var paired: DeviceTarget
        /** A made-up test code; the mock only compares it, nothing real is involved. */
        private const val CODE = "TEST2345"

        private fun mock(token: String?): DeviceTarget {
            val repo = File(System.getProperty("xscript.repo") ?: "../..")
            val py = System.getenv("XSCRIPT_TEST_PYTHON") ?: "python3"
            val code = "import sys, threading; sys.path.insert(0, sys.argv[1]); import mock_device;" +
                "s = mock_device.serve('127.0.0.1', 0, token=sys.argv[2] or None); print(s.server_address[1], flush=True); threading.Event().wait()"
            val p = ProcessBuilder(py, "-c", code, File(repo, "scripts").path, token ?: "")
                .redirectError(ProcessBuilder.Redirect.INHERIT).start()
            procs += p
            val port = p.inputStream.bufferedReader().readLine()?.trim()?.toInt() ?: error("mock_device did not start")
            return DeviceTarget("127.0.0.1", port)
        }

        @BeforeClass @JvmStatic fun start() {
            open = DeviceClient(mock(null))
            paired = mock(CODE)
        }

        @AfterClass @JvmStatic fun stopAll() = procs.forEach { it.destroy() }
    }

    @Test fun uploadRunLogsStop() {
        assertFalse(open.status().get("running").asBoolean)
        val up = open.uploadFiles("pyc_demo", listOf(
            UploadFile("__init__.py", "print('hi')\n", "utf-8"),
            UploadFile("res/a.bin", Base64.getEncoder().encodeToString(byteArrayOf(1, 2, 3)), "base64"),
        ))
        assertTrue(up.get("ok").asBoolean)
        assertEquals(2, up.get("count").asInt)
        assertTrue("pyc_demo" in open.listProjects())
        val remote = open.projectFiles("pyc_demo")!!.associate { it.path to it.size }
        assertEquals(3L, remote["res/a.bin"])
        assertNull(open.projectFiles("no_such_project"))

        val since = open.currentSeq()
        assertTrue(open.run("pyc_demo").get("running").asBoolean)
        assertEquals("already running", open.run("pyc_demo").get("error").asString)
        assertEquals("pyc_demo", open.status().get("project").asString)
        assertNotNull(open.logs(since).next)

        assertFalse(open.stop("pyc_demo").get("running").asBoolean)
        // after the stop, following ends within a few quiet polls
        val state = FollowState(open.currentSeq())
        var polls = 0
        while (followTick(open, state) {} && polls < 10) polls++
        assertTrue(polls < 10)
    }

    @Test fun stopIfRunningRestartsCleanly() {
        open.uploadFiles("pyc_again", listOf(UploadFile("__init__.py", "", "utf-8")))
        assertTrue(open.run("pyc_again").get("running").asBoolean)
        assertEquals("pyc_again", open.stopIfRunning())
        assertNull(open.stopIfRunning())
        assertTrue(open.run("pyc_again").get("running").asBoolean) // not "already running"
        open.stop("pyc_again")
    }

    @Test fun unicodeProjectNameIsEncoded() {
        assertTrue(open.uploadFiles("脚本_1", listOf(UploadFile("__init__.py", "", "utf-8"))).get("ok").asBoolean)
        assertTrue("脚本_1" in open.listProjects())
    }

    @Test fun pairing() {
        try {
            DeviceClient(paired).listProjects()
            fail("expected 401")
        } catch (e: DeviceHttpException) {
            assertTrue(e.isPairing)
        }
        try {
            DeviceClient(paired, token = "WRONG234").listProjects()
            fail("expected 401")
        } catch (e: DeviceHttpException) {
            assertEquals(401, e.status)
        }
        assertNotNull(DeviceClient(paired, token = "test-2345").listProjects())
    }

    @Test fun errorDetail() {
        assertEquals("工程已存在: demo", DeviceHttpException.detailOf("{\"error\": \"工程已存在: demo\"}"))
        assertEquals("plain", DeviceHttpException.detailOf("plain"))
        assertEquals("HTTP 409: busy", DeviceHttpException(409, "{\"msg\":\"busy\"}").message)
    }
}
