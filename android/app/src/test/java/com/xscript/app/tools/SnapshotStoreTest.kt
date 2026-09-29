package com.xscript.app.tools

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files

class SnapshotStoreTest {
    private lateinit var root: File
    private val png = byteArrayOf(0x89.toByte(), 'P'.code.toByte(), 'N'.code.toByte(), 'G'.code.toByte(), 13, 10, 26, 10)

    @Before
    fun setUp() {
        root = Files.createTempDirectory("snap").toFile()
    }

    @After
    fun tearDown() {
        root.deleteRecursively()
    }

    @Test
    fun saveDescribeAndRejectNonPng() {
        val store = SnapshotStore(root)
        val s = store.save(png, 1080, 1920)
        assertEquals(1080, s.getInt("width"))
        assertEquals("/tools/snapshots/${s.getString("id")}.png", s.getString("url"))
        assertNotNull(store.file(s.getString("id")))
        assertThrows(IllegalArgumentException::class.java) { store.save("nope".toByteArray(), 1, 1) }
    }

    @Test
    fun rejectsTraversalIds() {
        val store = SnapshotStore(root)
        assertThrows(IllegalArgumentException::class.java) { store.file("../../etc/passwd") }
        assertNull(store.file("123_1"))
    }

    @Test
    fun prunesOldestBeyondKeep() {
        val store = SnapshotStore(root, keep = 3)
        val ids = (1..5).map { store.save(png, 1, 1).getString("id") }
        val left = store.list()
        assertEquals(3, left.length())
        // Newest first.
        assertEquals(ids.last(), left.getJSONObject(0).getString("id"))
        assertNull(store.file(ids[0]))
        assertNull(store.file(ids[1]))
        assertEquals(6, root.listFiles()!!.size) // png + json per kept snapshot
    }
}
