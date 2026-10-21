package com.xscript.pycharm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

class LocalProjectTest {
    @Test fun findRootAndCollect() {
        val ws = Files.createTempDirectory("xs-pyc-")
        val proj = ws.resolve("demo")
        Files.createDirectories(proj.resolve("lib/__pycache__"))
        Files.createDirectories(proj.resolve("res/img"))
        Files.createDirectories(proj.resolve("dist"))
        Files.createDirectories(proj.resolve(".vscode"))
        Files.writeString(proj.resolve("__init__.py"), "print('hi')\n")
        Files.writeString(proj.resolve("lib/__init__.py"), "X = '中文'\n")
        Files.writeString(proj.resolve("lib/__pycache__/x.pyc"), "junk")
        Files.writeString(proj.resolve(".hidden"), "junk")
        Files.writeString(proj.resolve("dist/out.txt"), "junk")
        Files.writeString(proj.resolve("run.log"), "junk")
        Files.writeString(proj.resolve(".vscode/.syncignore"), "*.log\ndist/\n")
        Files.write(proj.resolve("res/img/a.png"), byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47))

        assertEquals(proj, LocalProject.findRoot(proj.resolve("lib/__init__.py"), ws))
        assertEquals(proj, LocalProject.findRoot(proj.resolve("res/img"), ws))
        assertNull(LocalProject.findRoot(ws, ws))

        val files = LocalProject.collectFiles(proj)
        assertEquals(listOf("__init__.py", "lib/__init__.py", "res/img/a.png"), files.map { it.path })
        assertEquals(UploadFile("lib/__init__.py", "X = '中文'\n", "utf-8"), files[1])
        assertEquals("base64", files[2].encoding)
        ws.toFile().deleteRecursively()
    }

    @Test fun ignoreRules() {
        val r = IgnoreRules("# c\n*.log\nbuild/\n/top.txt\ndocs/**/*.md\n!keep.log\n")
        assertEquals(5, r.size)
        assertTrue(r.ignores("a/b.log", false))
        assertFalse(r.ignores("keep.log", false))
        assertTrue(r.ignores("x/build", true))
        assertFalse(r.ignores("x/build", false))
        assertTrue(r.ignores("top.txt", false))
        assertFalse(r.ignores("sub/top.txt", false))
        assertTrue(r.ignores("docs/a/b/c.md", false))
        assertTrue(r.ignores("docs/c.md", false))
    }

    @Test fun pairingCodes() {
        assertEquals("ABCDEFGH", normalizeCode(" abcd-efgh "))
        assertNull(validateCode("abcd-2345"))
        assertEquals("8 letters or digits, e.g. ABCD-EFGH", validateCode("abc"))
    }
}
