package com.xscript.app.http

import com.xscript.app.project.ProjectStore
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files

/** HTTP-level contract of the Web IDE project/file endpoints (status codes and JSON bodies). */
class ProjectRoutesTest {
    private lateinit var root: File
    private lateinit var routes: ProjectRoutes

    @Before
    fun setUp() {
        root = Files.createTempDirectory("routes").toFile()
        routes = ProjectRoutes(ProjectStore(root))
    }

    @After
    fun tearDown() {
        root.deleteRecursively()
    }

    private class Res(val status: Int, val json: JSONObject)

    /** Same dispatch and error mapping as [ApiRouter.handle] for `/projects/<name><sub>`. */
    private fun call(method: String, name: String, sub: String, body: JSONObject? = null, query: Map<String, String> = emptyMap()): Res {
        val req = ApiRouter.Request(method, "/projects/$name$sub", query,
            if (body == null) ApiRouter.Body.EMPTY else ApiRouter.Body.of(body.toString().toByteArray()))
        val reply = try {
            routes.handle(method, name, sub, req) ?: ApiRouter.Reply.json(JSONObject().put("error", "not found"), 404)
        } catch (e: Exception) {
            ApiRouter.errorReply(e)
        }
        return Res(reply.status, JSONObject(String(reply.bytes(), Charsets.UTF_8)))
    }

    private fun file(path: String, content: String = "", create: Boolean = true) =
        JSONObject().put("path", path).put("content", content).put("create", create)

    @Test
    fun createProjectStatusCodes() {
        val ok = call("POST", "demo", "")
        assertEquals(200, ok.status)
        assertEquals("demo", ok.json.getString("project"))
        assertEquals(409, call("POST", "demo", "").status)
        assertTrue(call("POST", "demo", "").json.getString("error").contains("已存在"))
        assertEquals(400, call("POST", "bad name", "").status)
        assertEquals(400, call("POST", "9x", "").status)
        assertEquals(200, call("POST", "中文_工程", "").status)
    }

    @Test
    fun listFilesIncludesEmptyDirs() {
        call("POST", "demo", "")
        assertEquals(200, call("POST", "demo", "/dir", JSONObject().put("path", "assets/img")).status)
        val r = call("GET", "demo", "/files")
        assertEquals(200, r.status)
        val files = r.json.getJSONArray("files")
        assertEquals("__init__.py", files.getJSONObject(0).getString("path"))
        val dirs = (0 until r.json.getJSONArray("dirs").length()).map { r.json.getJSONArray("dirs").getString(it) }
        assertTrue(dirs.containsAll(listOf("assets", "assets/img", "res", "res/img")))
    }

    @Test
    fun createFileAndFolderErrors() {
        call("POST", "demo", "")
        val created = call("PUT", "demo", "/files", file("\\lib\\a.py", "A = 1\n"))
        assertEquals(200, created.status)
        assertEquals("lib/a.py", created.json.getString("path"))
        assertEquals(409, call("PUT", "demo", "/files", file("lib/a.py")).status)
        assertEquals(409, call("PUT", "demo", "/files", file("lib")).status)
        assertEquals(404, call("PUT", "missing", "/files", file("a.py")).status)
        assertEquals(400, call("PUT", "demo", "/files", file("../evil.py")).status)
        assertEquals(400, call("PUT", "demo", "/files", file("")).status)
        assertEquals(404, call("PUT", "bad name", "/files", file("a.py")).status)
        // Plain write (no create flag) overwrites.
        assertEquals(200, call("PUT", "demo", "/files", file("lib/a.py", "A = 2\n", create = false)).status)
        assertEquals("A = 2\n", call("GET", "demo", "/file", query = mapOf("path" to "lib/a.py")).json.getString("content"))
        assertEquals(400, call("PUT", "demo", "/files", file("lib", "x", create = false)).status)
        assertEquals(409, call("POST", "demo", "/dir", JSONObject().put("path", "lib")).status)
        assertEquals(404, call("POST", "missing", "/dir", JSONObject().put("path", "x")).status)
        assertEquals(400, call("POST", "demo", "/dir", JSONObject()).status)
        assertEquals(400, call("POST", "demo", "/dir", JSONObject().put("path", "a/../b")).status)
    }

    @Test
    fun batchWriteAndReadEncodings() {
        call("POST", "demo", "")
        val batch = JSONObject().put("files", org.json.JSONArray()
            .put(JSONObject().put("path", "x.py").put("content", "print(1)\n"))
            .put(JSONObject().put("path", "img/p.png").put("content", "iVBORw==").put("encoding", "base64")))
        val r = call("PUT", "demo", "/files", batch)
        assertEquals(200, r.status)
        assertEquals(2, r.json.getInt("count"))
        val text = call("GET", "demo", "/file", query = mapOf("path" to "x.py")).json
        assertEquals("utf-8", text.getString("encoding"))
        val bin = call("GET", "demo", "/file", query = mapOf("path" to "img/p.png")).json
        assertEquals("base64", bin.getString("encoding"))
        assertEquals("iVBORw==", bin.getString("content"))
        assertEquals(404, call("GET", "demo", "/file", query = mapOf("path" to "nope.py")).status)
        assertEquals(404, call("GET", "demo", "/file", query = mapOf("path" to "img")).status)
        assertEquals(400, call("GET", "demo", "/file", query = mapOf("path" to "../x")).status)
    }

    @Test
    fun deleteStatusCodes() {
        call("POST", "demo", "")
        call("PUT", "demo", "/files", file("pkg/m.py"))
        val q = { p: String -> mapOf("path" to p) }
        assertEquals(400, call("DELETE", "demo", "/file", query = q("__init__.py")).status)
        assertEquals(409, call("DELETE", "demo", "/file", query = q("pkg")).status)
        assertEquals(404, call("DELETE", "demo", "/file", query = q("missing.py")).status)
        assertEquals(400, call("DELETE", "demo", "/file").status)
        assertEquals(200, call("DELETE", "demo", "/file", query = q("pkg/m.py")).status)
        assertEquals(200, call("DELETE", "demo", "/file", query = q("pkg")).status)
        assertEquals(404, call("DELETE", "demo", "/file", query = q("pkg")).status)
    }

    @Test
    fun unrelatedRoutesAreNotHandled() {
        val req = ApiRouter.Request("POST", "/projects/demo/run", emptyMap(), ApiRouter.Body.EMPTY)
        assertNull(routes.handle("POST", "demo", "/run", req))
        assertNull(routes.handle("GET", "demo", "/zip", req))
        assertNull(routes.handle("DELETE", "demo", "", req))
    }

    @Test
    fun errorMappingMatchesTheContract() {
        assertEquals(404, ApiRouter.errorReply(NoSuchElementException("x")).status)
        assertEquals(400, ApiRouter.errorReply(IllegalArgumentException("x")).status)
        assertEquals(409, ApiRouter.errorReply(IllegalStateException("x")).status)
        assertEquals(500, ApiRouter.errorReply(RuntimeException("boom")).status)
        assertEquals("boom", JSONObject(String(ApiRouter.errorReply(RuntimeException("boom")).body)).getString("error"))
        assertEquals(500, ApiRouter.errorReply(java.io.IOException()).status)
    }
}
