package com.xscript.app.project

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files

/** Web IDE 新建工程 / 新建文件 / 新建文件夹 / 删除文件 storage rules (HTTP status follows the exception type). */
class ProjectStoreTest {
    private lateinit var root: File
    private lateinit var store: ProjectStore

    @Before
    fun setUp() {
        root = Files.createTempDirectory("projects").toFile()
        store = ProjectStore(root)
    }

    @After
    fun tearDown() {
        root.deleteRecursively()
    }

    @Test
    fun createNewMakesEntryAndRejectsInvalidOrDuplicateNames() {
        store.createNew("demo")
        assertTrue(File(root, "demo/__init__.py").isFile)
        assertEquals(listOf("demo"), store.list())
        assertThrows(IllegalStateException::class.java) { store.createNew("demo") }
        for (bad in listOf("../x", "with space", "9start", "a/b", "")) {
            assertThrows(IllegalArgumentException::class.java) { store.createNew(bad) }
        }
        store.createNew("中文_工程")
        assertTrue(store.exists("中文_工程"))
    }

    @Test
    fun createFileIsCreateOnlyAndSupportsSubfolders() {
        store.createNew("demo")
        store.createFile("demo", "lib/sub/mod.py", "X = 1\n", "utf-8")
        assertEquals("X = 1\n", File(root, "demo/lib/sub/mod.py").readText())
        assertThrows(IllegalStateException::class.java) { store.createFile("demo", "lib/sub/mod.py", "", "utf-8") }
        assertThrows(IllegalStateException::class.java) { store.createFile("demo", "__init__.py", "", "utf-8") }
        assertThrows(NoSuchElementException::class.java) { store.createFile("missing", "a.py", "", "utf-8") }
        for (bad in listOf("../evil.py", "a/../../evil.py", "./a.py", "a//b.py", "", "lib/./x.py")) {
            assertThrows(IllegalArgumentException::class.java) { store.createFile("demo", bad, "", "utf-8") }
        }
        assertFalse(File(root, "evil.py").exists())
    }

    @Test
    fun createDirIsListedAndDuplicatesConflict() {
        store.createNew("demo")
        store.createDir("demo", "assets/data")
        val dirs = (0 until store.dirs("demo").length()).map { store.dirs("demo").getString(it) }
        assertTrue(dirs.contains("assets/data"))
        assertThrows(IllegalStateException::class.java) { store.createDir("demo", "assets/data") }
        assertThrows(IllegalArgumentException::class.java) { store.createDir("demo", "../outside") }
    }

    @Test
    fun deleteFileRulesProtectEntryAndNonEmptyFolders() {
        store.createNew("demo")
        store.createFile("demo", "pkg/mod.py", "", "utf-8")
        assertThrows(IllegalArgumentException::class.java) { store.deleteFile("demo", "__init__.py") }
        assertThrows(IllegalStateException::class.java) { store.deleteFile("demo", "pkg") }
        assertThrows(NoSuchElementException::class.java) { store.deleteFile("demo", "missing.py") }
        assertThrows(IllegalArgumentException::class.java) { store.deleteFile("demo", "../demo/__init__.py") }
        assertTrue(store.deleteFile("demo", "pkg/mod.py"))
        assertTrue(store.deleteFile("demo", "pkg"))
        assertFalse(File(root, "demo/pkg").exists())
        assertTrue(File(root, "demo/__init__.py").isFile)
    }

    @Test
    fun deleteFolderRemovesEverythingInsideButNeverFollowsSymlinks() {
        store.createNew("demo")
        store.createFile("demo", "pkg/a.py", "", "utf-8")
        store.createFile("demo", "pkg/sub/b.py", "", "utf-8")
        store.createDir("demo", "pkg/empty")
        val outside = File(root.parentFile, "outside-${System.nanoTime()}").apply { mkdirs() }
        File(outside, "keep.txt").writeText("keep")
        java.nio.file.Files.createSymbolicLink(File(root, "demo/pkg/link").toPath(), outside.toPath())
        assertEquals(3, store.deleteFolder("demo", "pkg"))           // a.py, sub/b.py and the link itself
        assertFalse(File(root, "demo/pkg").exists())
        assertTrue("the link target outside the project is untouched", File(outside, "keep.txt").isFile)
        assertTrue(File(root, "demo/__init__.py").isFile)
        assertThrows(IllegalArgumentException::class.java) { store.deleteFolder("demo", "__init__.py") }
        assertThrows(IllegalArgumentException::class.java) { store.deleteFolder("demo", "") }
        assertThrows(IllegalArgumentException::class.java) { store.deleteFolder("demo", "../demo") }
        assertThrows(NoSuchElementException::class.java) { store.deleteFolder("demo", "pkg") }
        store.createFile("demo", "one.py", "", "utf-8")
        assertEquals(1, store.deleteFolder("demo", "one.py"))       // a plain file is just deleted
        outside.deleteRecursively()
    }
}
