package com.xscript.app.tools

import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Before
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import java.util.zip.ZipInputStream

class DatasetStoreTest {
    private lateinit var root: File
    private lateinit var store: DatasetStore

    // Magic bytes are all the store checks; the images are never decoded.
    private val png = byteArrayOf(0x89.toByte(), 'P'.code.toByte(), 'N'.code.toByte(), 'G'.code.toByte(), 13, 10, 26, 10, 0, 0)
    private val jpg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xE0.toByte(), 0, 0)

    @Before
    fun setUp() {
        root = Files.createTempDirectory("ds").toFile()
        store = DatasetStore(root)
    }

    @After
    fun tearDown() {
        root.deleteRecursively()
    }

    private fun label(w: Int, h: Int, vararg boxes: Pair<Int, List<Int>>) = JSONObject()
        .put("width", w).put("height", h)
        .put("boxes", JSONArray(boxes.map { JSONObject().put("cls", it.first).put("rect", JSONArray(it.second)) }))

    private fun unzip(bytes: ByteArray): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        ZipInputStream(ByteArrayInputStream(bytes)).use { z ->
            var e = z.nextEntry
            while (e != null) {
                out[e.name] = String(z.readBytes(), Charsets.UTF_8)
                e = z.nextEntry
            }
        }
        return out
    }

    @Test
    fun deleteLabelMakesImageUnlabelledAgain() {
        store.create("btns")
        store.setClasses("btns", JSONArray(listOf("ok")))
        val id = store.addImage("btns", png, "png")
        store.saveLabel("btns", id, label(10, 10))
        assertTrue(store.describe("btns").getJSONArray("items").getJSONObject(0).getBoolean("labeled"))
        assertTrue(store.deleteLabel("btns", id))
        assertFalse(store.describe("btns").getJSONArray("items").getJSONObject(0).getBoolean("labeled"))
        assertFalse(store.deleteLabel("btns", id))
        assertThrows(IllegalArgumentException::class.java) { store.deleteLabel("btns", "../x") }
    }

    @Test
    fun createListAndDelete() {
        store.create("btns")
        assertEquals(1, store.list().length())
        assertTrue(store.exists("btns"))
        assertTrue(store.delete("btns"))
        assertFalse(store.exists("btns"))
        assertEquals(0, store.list().length())
    }

    @Test
    fun rejectsBadNames() {
        assertThrows(IllegalArgumentException::class.java) { store.create("../evil") }
        assertThrows(IllegalArgumentException::class.java) { store.create("a/b") }
        assertThrows(IllegalArgumentException::class.java) { store.create("") }
        store.create("中文_ok-1")
        assertTrue(store.exists("中文_ok-1"))
    }

    @Test
    fun addImageAssignsSequentialIdsAndSniffs() {
        store.create("d")
        assertEquals("000001", store.addImage("d", png, "png"))
        assertEquals("000002", store.addImage("d", jpg, "jpg"))
        assertThrows(IllegalArgumentException::class.java) { store.addImage("d", "hello".toByteArray(), "png") }
        assertThrows(IllegalArgumentException::class.java) { store.addImage("d", png, "gif") }
        assertNotNull(store.imageFile("d", "000002"))
        assertThrows(IllegalArgumentException::class.java) { store.imageFile("d", "../x") }
        assertTrue(store.deleteImage("d", "000001"))
        assertNull(store.imageFile("d", "000001"))
        // Ids keep increasing after a delete so old label files never get reused.
        assertEquals("000003", store.addImage("d", png, "png"))
    }

    @Test
    fun saveLabelClampsNormalisesAndValidates() {
        store.create("d")
        store.setClasses("d", JSONArray(listOf("a", "b")))
        val id = store.addImage("d", png, "png")
        val saved = store.saveLabel(
            "d", id,
            label(100, 50, 1 to listOf(90, 40, 10, 10), 0 to listOf(-5, -5, 20, 20), 0 to listOf(30, 30, 30, 40)),
        )
        val boxes = saved.getJSONArray("boxes")
        assertEquals(2, boxes.length()) // zero-width box dropped
        assertEquals(listOf(10, 10, 90, 40), (0 until 4).map { boxes.getJSONObject(0).getJSONArray("rect").getInt(it) })
        assertEquals(listOf(0, 0, 20, 20), (0 until 4).map { boxes.getJSONObject(1).getJSONArray("rect").getInt(it) })
        assertEquals(2, store.label("d", id).getJSONArray("boxes").length())
        assertThrows(IllegalArgumentException::class.java) { store.saveLabel("d", id, label(100, 50, 5 to listOf(0, 0, 5, 5))) }
        assertThrows(IllegalArgumentException::class.java) { store.saveLabel("d", "999999", label(100, 50)) }
    }

    @Test
    fun classesCannotDropIndicesInUse() {
        store.create("d")
        store.setClasses("d", JSONArray(listOf("a", "b", "c")))
        val id = store.addImage("d", png, "png")
        store.saveLabel("d", id, label(10, 10, 1 to listOf(0, 0, 5, 5)))
        assertThrows(IllegalArgumentException::class.java) { store.setClasses("d", JSONArray(listOf("a"))) }
        assertThrows(IllegalArgumentException::class.java) { store.setClasses("d", JSONArray(listOf("a", "a"))) }
        // Renaming and dropping the unused tail are fine.
        store.setClasses("d", JSONArray(listOf("A", "B")))
        assertEquals("B", store.describe("d").getJSONArray("classes").getString(1))
    }

    @Test
    fun deleteClassRemapsLabelsAndCounts() {
        store.create("d")
        store.setClasses("d", JSONArray(listOf("a", "b", "c")))
        val id = store.addImage("d", png, "png")
        store.saveLabel("d", id, label(10, 10, 0 to listOf(0, 0, 2, 2), 1 to listOf(1, 1, 3, 3), 2 to listOf(2, 2, 5, 5)))
        val before = store.describe("d")
        assertEquals(listOf(1, 1, 1), (0 until 3).map { before.getJSONArray("counts").getInt(it) })
        assertTrue(before.getJSONArray("items").getJSONObject(0).getBoolean("labeled"))
        val after = store.deleteClass("d", 1)
        assertEquals(listOf("a", "c"), (0 until 2).map { after.getJSONArray("classes").getString(it) })
        val boxes = store.label("d", id).getJSONArray("boxes")
        assertEquals(listOf(0, 1), (0 until boxes.length()).map { boxes.getJSONObject(it).getInt("cls") })
        assertEquals(listOf(2, 2, 5, 5), (0 until 4).map { boxes.getJSONObject(1).getJSONArray("rect").getInt(it) })
        assertThrows(IllegalArgumentException::class.java) { store.deleteClass("d", 5) }
    }

    @Test
    fun renameMovesDataset() {
        store.create("old")
        store.addImage("old", png, "png")
        store.create("taken")
        assertThrows(IllegalArgumentException::class.java) { store.rename("old", "taken") }
        assertThrows(IllegalArgumentException::class.java) { store.rename("old", "../x") }
        assertEquals(1, store.rename("old", "new").getJSONArray("items").length())
        assertFalse(store.exists("old"))
        assertTrue(store.exists("new"))
    }

    @Test
    fun yoloLinesAreNormalised() {
        val lines = DatasetStore.yoloLines(label(200, 100, 0 to listOf(50, 25, 150, 75), 1 to listOf(0, 0, 200, 100)))
        assertEquals("0 0.500000 0.500000 0.500000 0.500000\n1 0.500000 0.500000 1.000000 1.000000\n", lines)
        assertEquals("", DatasetStore.yoloLines(label(10, 10)))
    }

    @Test
    fun exportYoloLayout() {
        store.create("d")
        store.setClasses("d", JSONArray(listOf("btn", "say \"hi\"")))
        val ids = (1..6).map { store.addImage("d", png, "png") }
        ids.take(5).forEachIndexed { i, id ->
            store.saveLabel("d", id, if (i == 0) label(10, 10) else label(10, 10, 0 to listOf(0, 0, 5, 5)))
        }
        // ids[5] has no label file and must be skipped.
        val out = ByteArrayOutputStream()
        assertEquals(5, store.exportYolo("d", out))
        val zip = unzip(out.toByteArray())
        val trainImgs = zip.keys.filter { it.startsWith("images/train/") }
        val valImgs = zip.keys.filter { it.startsWith("images/val/") }
        assertEquals(4, trainImgs.size)
        assertEquals(listOf("images/val/${ids[4]}.png"), valImgs)
        assertEquals("", zip["labels/train/${ids[0]}.txt"]) // negative sample kept
        assertEquals("0 0.250000 0.250000 0.500000 0.500000\n", zip["labels/val/${ids[4]}.txt"])
        assertFalse(zip.keys.any { it.contains(ids[5]) })
        val yaml = zip["data.yaml"]!!
        assertTrue(yaml.contains("nc: 2"))
        assertTrue(yaml.contains("  0: \"btn\""))
        assertTrue(yaml.contains("  1: \"say \\\"hi\\\"\""))
    }

    @Test
    fun exportSingleImageAlsoFillsVal() {
        store.create("d")
        store.setClasses("d", JSONArray(listOf("x")))
        val id = store.addImage("d", png, "png")
        store.saveLabel("d", id, label(10, 10, 0 to listOf(1, 1, 4, 4)))
        val out = ByteArrayOutputStream()
        store.exportYolo("d", out)
        val zip = unzip(out.toByteArray())
        assertTrue(zip.containsKey("images/train/$id.png"))
        assertTrue(zip.containsKey("images/val/$id.png"))
    }

    @Test
    fun exportRequiresClassesAndLabels() {
        store.create("d")
        assertThrows(IllegalArgumentException::class.java) { store.exportYolo("d", ByteArrayOutputStream()) }
        store.setClasses("d", JSONArray(listOf("x")))
        store.addImage("d", png, "png")
        assertThrows(IllegalArgumentException::class.java) { store.exportYolo("d", ByteArrayOutputStream()) }
    }
}
