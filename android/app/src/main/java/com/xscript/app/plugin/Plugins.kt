package com.xscript.app.plugin

import com.xscript.app.XscriptApp
import dalvik.system.DexClassLoader
import java.io.File
import java.security.MessageDigest

/**
 * `plug.load_apk`: loads third-party APK/JAR/DEX code with DexClassLoader in the script process and exposes reflection to
 * Python (called directly through Chaquopy). Only files inside the app's own storage are accepted (see [PluginPaths]);
 * the file is copied into private code-cache storage and made read-only first (Android 14 refuses writable dex files).
 */
object Plugins {
    private val loaders = HashMap<String, ClassLoader>()

    private fun roots(): List<File> {
        val ctx = XscriptApp.instance
        return listOfNotNull(ctx.filesDir, ctx.getExternalFilesDir(null), ctx.cacheDir)
    }

    /** Returns a handle (content hash) used by [loadClass]. Loading the same bytes twice reuses the loader. */
    @JvmStatic
    @Synchronized
    fun load(path: String): String {
        val src = PluginPaths.check(path, roots())
        val bytes = src.readBytes()
        val id = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }.take(16)
        loaders[id]?.let { return id }
        val dir = File(XscriptApp.instance.codeCacheDir, "plugins").apply { mkdirs() }
        val copy = File(dir, "$id.${src.extension.lowercase()}")
        if (!copy.exists()) {
            val tmp = File(dir, "$id.tmp")
            tmp.writeBytes(bytes)
            tmp.renameTo(copy)
        }
        copy.setWritable(false, false)
        val opt = File(dir, "$id-opt").apply { mkdirs() }
        loaders[id] = DexClassLoader(copy.absolutePath, opt.absolutePath, null, Plugins::class.java.classLoader)
        return id
    }

    @JvmStatic
    @Synchronized
    fun loadClass(id: String, name: String): Class<*> {
        val l = loaders[id] ?: throw IllegalStateException("plugin $id is not loaded")
        return l.loadClass(name)
    }

    @JvmStatic fun newInstance(cls: Class<*>, args: Array<Any?>): Any = Reflect.newInstance(cls, args)
    @JvmStatic fun invoke(cls: Class<*>, target: Any?, name: String, args: Array<Any?>): Any? = Reflect.invoke(cls, target, name, args)
    @JvmStatic fun getField(cls: Class<*>, target: Any?, name: String): Any? = Reflect.getField(cls, target, name)
    @JvmStatic fun setField(cls: Class<*>, target: Any?, name: String, value: Any?) = Reflect.setField(cls, target, name, value)
}
