package com.xscript.app.ml

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.nio.file.Files

class ModelStoreTest {
    @get:Rule
    val tmp = TemporaryFolder()

    @Test
    fun pathsStayInsideTheModelFolder() {
        val base = tmp.newFolder("models")
        assertEquals(File(base, "yolo/best.onnx").canonicalPath, ModelStore.resolve(base, "yolo/best.onnx").canonicalPath)
        assertThrows(IllegalArgumentException::class.java) { ModelStore.resolve(base, "../secret") }
        assertThrows(IllegalArgumentException::class.java) { ModelStore.resolve(base, "a/../../x") }
        assertThrows(IllegalArgumentException::class.java) { ModelStore.resolve(base, "") }
    }

    @Test
    fun symlinkOutOfTheFolderIsRefused() {
        val base = tmp.newFolder("models2")
        val outside = tmp.newFolder("outside")
        Files.createSymbolicLink(File(base, "link").toPath(), outside.toPath())
        assertThrows(IllegalArgumentException::class.java) { ModelStore.resolve(base, "link/x.onnx") }
    }
}
