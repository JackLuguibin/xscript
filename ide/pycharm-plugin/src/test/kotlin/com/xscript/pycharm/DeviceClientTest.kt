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

    @Test fun evalSelection() {
        val r = open.eval("_result = 1 + 1")
        assertTrue(r.ok)
        assertEquals("2", r.result)
        assertEquals(">>> a = 1\n... _result = a\nmock:a = 1\n_result = a\n",
            formatEval("a = 1\n_result = a\n", EvalResult(true, "mock:a = 1\n_result = a", "")))
        assertEquals(">>> x\nerror: timeout\n", formatEval("x", EvalResult(false, "", "timeout")))
        assertEquals("print(1)", evalCode("", "print(1)"))
        assertEquals("a\nb", evalCode("a\nb", "ignored"))
        assertNull(evalCode(null, "   "))
    }

    @Test fun pullProjectWritesOnlyNewOrChangedFiles() {
        val bin = byteArrayOf(0, 1, 2, -1)
        open.uploadFiles("pyc_pull", listOf(
            UploadFile("__init__.py", "print('device')\n", "utf-8"),
            UploadFile("lib/util.py", "A = 1\n", "utf-8"),
            UploadFile("res/img/a.png", Base64.getEncoder().encodeToString(bin), "base64"),
        ))
        val root = java.nio.file.Files.createTempDirectory("xs-pull-").resolve("pyc_pull")
        try {
            val pulled = ProjectPull.fetch(open, "pyc_pull")
            assertEquals(listOf("__init__.py", "lib/util.py", "res/img/a.png"), pulled.map { it.path }.sorted())
            assertEquals(3, ProjectPull.write(root, pulled))
            assertTrue(java.nio.file.Files.readAllBytes(root.resolve("res/img/a.png")).contentEquals(bin))

            // a local edit and a local-only file: the edit shows as changed, the extra file is kept
            java.nio.file.Files.writeString(root.resolve("lib/util.py"), "A = 2\n")
            java.nio.file.Files.writeString(root.resolve("local.txt"), "mine\n")
            val again = ProjectPull.fetch(open, "pyc_pull")
            val d = ProjectPull.diff(root, again)
            assertEquals(listOf("lib/util.py"), d.changed)
            assertEquals(emptyList<String>(), d.added)
            assertEquals(2, d.unchanged.size)
            assertEquals(1, ProjectPull.write(root, again, d))
            assertEquals("A = 1\n", java.nio.file.Files.readString(root.resolve("lib/util.py")))
            assertTrue(java.nio.file.Files.exists(root.resolve("local.txt")))
            assertEquals(0, ProjectPull.write(root, again))
        } finally {
            root.parent.toFile().deleteRecursively()
        }
        try { ProjectPull.fetch(open, "no_such_project"); fail("expected missing project") } catch (_: IllegalStateException) {}
    }

    @Test fun incrementalUploadAgainstTheMock() {
        val files = listOf(UploadFile("__init__.py", "print(1)\n", "utf-8"), UploadFile("lib/a.py", "A = 1\n", "utf-8"))
        val first = UploadPlanner.plan(files, open.projectFiles("pyc_inc"), emptyMap())
        assertEquals(2, first.upload.size)
        open.uploadFiles("pyc_inc", first.upload)
        val again = UploadPlanner.plan(files, open.projectFiles("pyc_inc"), first.hashes)
        assertEquals(0, again.upload.size)
        assertEquals(2, again.skipped)
        val edited = listOf(files[0], UploadFile("lib/a.py", "A = 22\n", "utf-8"))
        val third = UploadPlanner.plan(edited, open.projectFiles("pyc_inc"), again.hashes)
        assertEquals(listOf("lib/a.py"), third.upload.map { it.path })
        open.uploadFiles("pyc_inc", third.upload)
        assertEquals(7L, open.projectFiles("pyc_inc")!!.first { it.path == "lib/a.py" }.size)
    }

    @Test fun deviceProjectsListMarksTheRunningOne() {
        open.uploadFiles("pyc_list_b", listOf(UploadFile("__init__.py", "", "utf-8")))
        open.uploadFiles("Pyc_list_a", listOf(UploadFile("__init__.py", "", "utf-8")))
        open.stopIfRunning()
        val idle = DeviceProjects.load(open).filter { it.name.lowercase().startsWith("pyc_list_") }
        assertEquals(listOf(DeviceProjectRow("Pyc_list_a", false), DeviceProjectRow("pyc_list_b", false)), idle)
        assertTrue(open.run("pyc_list_b").get("running").asBoolean)
        try {
            val rows = DeviceProjects.load(open)
            assertEquals(listOf("pyc_list_b"), rows.filter { it.running }.map { it.name })
        } finally {
            open.stop("pyc_list_b")
        }
    }

    @Test fun pullRejectsUnsafePaths() {
        for (bad in listOf("", "/etc/passwd", "../x", "a/../b", "a//b", "./a", "a\\b", "a\u0000b")) assertFalse(bad, ProjectPull.safeRelative(bad))
        for (ok in listOf("a", "lib/x.py", "res/img/a b.png", "数据/表.csv")) assertTrue(ok, ProjectPull.safeRelative(ok))
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
