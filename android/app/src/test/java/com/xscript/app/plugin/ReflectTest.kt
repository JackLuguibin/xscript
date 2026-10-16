package com.xscript.app.plugin

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class Sample(val base: Int) {
    @JvmField var label: String = "x"
    constructor() : this(1)
    fun add(n: Int): Int = base + n
    fun add(n: Double): Double = base + n
    fun join(a: String, c: Char): String = a + c
    fun boom(): Nothing = throw IllegalStateException("boom")
    companion object {
        @JvmField var counter: Long = 0
        @JvmStatic fun twice(s: String): String = s + s
    }
}

class ReflectTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun constructorsAndOverloads() {
        val c = Sample::class.java
        val o = Reflect.newInstance(c, arrayOf(5L)) // Python int → Long → int parameter
        assertEquals(5, (o as Sample).base)
        assertEquals(1, (Reflect.newInstance(c, arrayOf()) as Sample).base)
        assertEquals(7, Reflect.invoke(c, o, "add", arrayOf(2L)))
        assertEquals(7.5, Reflect.invoke(c, o, "add", arrayOf(2.5)))
        assertEquals("ab", Reflect.invoke(c, o, "join", arrayOf("a", "b")))
        assertEquals("hihi", Reflect.invoke(c, null, "twice", arrayOf("hi")))
        assertEquals("hello", Reflect.invoke(String::class.java, "hello", "toString", arrayOf()))
    }

    @Test fun fields() {
        val c = Sample::class.java
        val o = Sample(1)
        Reflect.setField(c, o, "label", "y")
        assertEquals("y", Reflect.getField(c, o, "label"))
        Reflect.setField(c, null, "counter", 3L)
        assertEquals(3L, Reflect.getField(c, null, "counter"))
        assertThrows(IllegalArgumentException::class.java) { Reflect.setField(c, o, "label", 4L) }
    }

    @Test fun errors() {
        val c = Sample::class.java
        assertThrows(NoSuchMethodException::class.java) { Reflect.invoke(c, Sample(), "missing", arrayOf()) }
        assertEquals((1L shl 40) + 1.0, Reflect.invoke(c, Sample(), "add", arrayOf(1L shl 40))) // too big for int: the double overload
        assertThrows(NoSuchMethodException::class.java) { Reflect.invoke(c, Sample(), "join", arrayOf("a", "bc")) }
        assertThrows(NoSuchMethodException::class.java) { Reflect.invoke(c, null, "add", arrayOf(1L)) } // instance method, no target
        val e = assertThrows(IllegalStateException::class.java) { Reflect.invoke(c, Sample(), "boom", arrayOf()) }
        assertEquals("boom", e.message)
    }

    @Test fun pathPolicy() {
        val root = tmp.newFolder("files")
        val ok = File(root, "plugins/lib.jar").apply { parentFile!!.mkdirs(); writeText("x") }
        assertEquals(ok.canonicalFile, PluginPaths.check(ok.path, listOf(root)))
        val outside = tmp.newFile("evil.jar")
        assertThrows(IllegalArgumentException::class.java) { PluginPaths.check(outside.path, listOf(root)) }
        assertThrows(IllegalArgumentException::class.java) { PluginPaths.check(File(root, "../evil.jar").path, listOf(root)) }
        val txt = File(root, "a.txt").apply { writeText("x") }
        assertThrows(IllegalArgumentException::class.java) { PluginPaths.check(txt.path, listOf(root)) }
        assertThrows(IllegalArgumentException::class.java) { PluginPaths.check(File(root, "missing.apk").path, listOf(root)) }
        assertThrows(IllegalArgumentException::class.java) { PluginPaths.check("", listOf(root)) }
        val link = File(root, "link.jar")
        java.nio.file.Files.createSymbolicLink(link.toPath(), outside.toPath())
        assertThrows(IllegalArgumentException::class.java) { PluginPaths.check(link.path, listOf(root)) }
        assertTrue(PluginPaths.EXTENSIONS.contains("apk"))
    }
}
