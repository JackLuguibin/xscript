package com.xscript.app.project

import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Path-safety and concurrency edge cases of [ProjectStore] behind the Web IDE file API. */
class ProjectStoreEdgeTest {
    private lateinit var tmp: File
    private lateinit var root: File
    private lateinit var outside: File
    private lateinit var store: ProjectStore

    @Before
    fun setUp() {
        tmp = Files.createTempDirectory("store-edge").toFile()
        root = File(tmp, "projects")
        outside = File(tmp, "secret").apply { mkdirs(); File(this, "token.txt").writeText("TOP SECRET") }
        store = ProjectStore(root)
        store.createNew("demo")
    }

    @After
    fun tearDown() {
        tmp.deleteRecursively()
    }

    private fun link(at: File, target: File) = Files.createSymbolicLink(at.toPath(), target.toPath())

    @Test
    fun symlinkedFolderCannotEscapeTheProject() {
        link(File(root, "demo/leak"), outside)
        assertThrows(IllegalArgumentException::class.java) { store.readFile("demo", "leak/token.txt") }
        assertThrows(IllegalArgumentException::class.java) { store.writeFile("demo", "leak/new.py", "x", "utf-8") }
        assertThrows(IllegalArgumentException::class.java) { store.createFile("demo", "leak/new.py", "x", "utf-8") }
        assertThrows(IllegalArgumentException::class.java) { store.createDir("demo", "leak/sub") }
        assertThrows(IllegalArgumentException::class.java) { store.deleteFile("demo", "leak/token.txt") }
        assertEquals("TOP SECRET", File(outside, "token.txt").readText())
        // Listings do not walk into the link either.
        val files = (0 until store.files("demo").length()).map { store.files("demo").getJSONObject(it).getString("path") }
        val dirs = (0 until store.dirs("demo").length()).map { store.dirs("demo").getString(it) }
        assertFalse(files.any { it.startsWith("leak/") })
        assertFalse(dirs.any { it.startsWith("leak/") })
        assertFalse(File(outside, "new.py").exists())
        assertFalse(File(outside, "sub").exists())
    }

    @Test
    fun symlinkedFileCannotBeReadOrOverwritten() {
        link(File(root, "demo/alias.txt"), File(outside, "token.txt"))
        assertThrows(IllegalArgumentException::class.java) { store.readFile("demo", "alias.txt") }
        assertThrows(IllegalArgumentException::class.java) { store.writeFile("demo", "alias.txt", "pwned", "utf-8") }
        assertEquals("TOP SECRET", File(outside, "token.txt").readText())
    }

    @Test
    fun traversalAndOddPathsAreRejected() {
        for (bad in listOf("../x.py", "a/../../x.py", "./x.py", "a//b.py", "", "   ", "a\u0000.py", "..\\x.py", "a/./b.py")) {
            assertThrows("path <$bad>", IllegalArgumentException::class.java) { store.createFile("demo", bad, "", "utf-8") }
            assertThrows("path <$bad>", IllegalArgumentException::class.java) { store.readFile("demo", bad) }
        }
        // Backslashes and a leading slash are normalised to a project-relative path.
        assertEquals("lib/a.py", ProjectStore.normalizeRel("\\lib\\a.py"))
        assertEquals("lib/a.py", ProjectStore.normalizeRel("/lib/a.py"))
        // An invalid project name is simply a project that does not exist (404).
        assertThrows(NoSuchElementException::class.java) { store.createFile("bad name", "a.py", "", "utf-8") }
    }

    @Test
    fun unicodeNamesAndPathsRoundTrip() {
        store.createNew("工程_二")
        store.createNew("Ñandú_9")
        store.createFile("工程_二", "模块/工具.py", "名字 = '你好'\n", "utf-8")
        store.createDir("工程_二", "资源/图片")
        assertEquals("名字 = '你好'\n", store.readFile("工程_二", "模块/工具.py").readText())
        val files = (0 until store.files("工程_二").length()).map { store.files("工程_二").getJSONObject(it).getString("path") }
        assertTrue(files.contains("模块/工具.py"))
        val dirs = (0 until store.dirs("工程_二").length()).map { store.dirs("工程_二").getString(it) }
        assertTrue(dirs.containsAll(listOf("模块", "资源", "资源/图片")))
        assertTrue(store.list().containsAll(listOf("demo", "工程_二", "Ñandú_9")))
        assertTrue(store.deleteFile("工程_二", "模块/工具.py"))
        // Names must still be identifiers in any script.
        for (bad in listOf("工程-二", "工 程", "1工程", "emoji😀")) {
            assertThrows("name <$bad>", IllegalArgumentException::class.java) { store.createNew(bad) }
        }
    }

    @Test
    fun deepNestingCreatesParentsAndListsEveryLevel() {
        val deep = (1..30).joinToString("/") { "d$it" }
        store.createFile("demo", "$deep/leaf.py", "X = 1\n", "utf-8")
        assertEquals("X = 1\n", store.readFile("demo", "$deep/leaf.py").readText())
        val dirs = (0 until store.dirs("demo").length()).map { store.dirs("demo").getString(it) }
        assertEquals(30, dirs.count { it.startsWith("d1") })
        assertThrows(IllegalStateException::class.java) { store.deleteFile("demo", "d1") }
        store.deleteFile("demo", "$deep/leaf.py")
        // Remove bottom-up: every level is an (eventually) empty folder.
        for (i in 30 downTo 1) assertTrue(store.deleteFile("demo", (1..i).joinToString("/") { "d$it" }))
        assertFalse(File(root, "demo/d1").exists())
    }

    @Test
    fun base64WritesAreDecodedAndFoldersAreNotOverwritten() {
        val bytes = byteArrayOf(0, 1, 2, -1, 127)
        store.writeFile("demo", "res/img/a.bin", java.util.Base64.getEncoder().encodeToString(bytes), "base64")
        assertArrayEquals(bytes, store.readFile("demo", "res/img/a.bin").readBytes())
        // Wrapped (MIME) base64, as some clients send it.
        store.writeFile("demo", "b.bin", "AAEC\r\n/38=", "BASE64")
        assertArrayEquals(bytes, File(root, "demo/b.bin").readBytes())
        assertThrows(IllegalArgumentException::class.java) { store.writeFile("demo", "res", "x", "utf-8") }
        assertThrows(IllegalStateException::class.java) { store.createFile("demo", "res", "x", "utf-8") }
    }

    @Test
    fun concurrentCreatesHaveExactlyOneWinner() {
        repeat(20) { round ->
            val pool = Executors.newFixedThreadPool(8)
            val start = CountDownLatch(1)
            val projectWins = AtomicInteger()
            val projectConflicts = AtomicInteger()
            val fileWins = AtomicInteger()
            val fileConflicts = AtomicInteger()
            repeat(8) { i ->
                pool.submit {
                    start.await()
                    try { store.createNew("race_$round"); projectWins.incrementAndGet() } catch (e: IllegalStateException) { projectConflicts.incrementAndGet() }
                    try { store.createFile("demo", "race/$round.py", "writer $i", "utf-8"); fileWins.incrementAndGet() } catch (e: IllegalStateException) { fileConflicts.incrementAndGet() }
                }
            }
            start.countDown()
            pool.shutdown()
            assertTrue(pool.awaitTermination(10, TimeUnit.SECONDS))
            assertEquals("project winners in round $round", 1, projectWins.get())
            assertEquals(7, projectConflicts.get())
            assertEquals("file winners in round $round", 1, fileWins.get())
            assertEquals(7, fileConflicts.get())
            assertTrue(store.readFile("demo", "race/$round.py").readText().startsWith("writer "))
        }
    }

    @Test
    fun deletingAProjectFolderWithSymlinkLeavesTheTargetAlone() {
        link(File(root, "demo/leak"), outside)
        link(File(root, "demo/alias.txt"), File(outside, "token.txt"))
        assertTrue(store.delete("demo"))
        assertFalse(File(root, "demo").exists())
        assertEquals("TOP SECRET", File(outside, "token.txt").readText())
        assertTrue(outside.isDirectory)
    }
}
