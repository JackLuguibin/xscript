package com.xscript.app.plugin

import java.io.File

/** Which files `plug.load_apk` may load: .apk/.jar/.dex/.aar-classes inside the app's own storage only. Pure for tests. */
object PluginPaths {
    val EXTENSIONS = setOf("apk", "jar", "dex", "zip")

    /** Canonical file when [path] is an allowed plugin file under one of [roots]; throws otherwise (symlinks resolved). */
    fun check(path: String, roots: List<File>): File {
        require(path.isNotBlank()) { "plugin path is empty" }
        val f = File(path).canonicalFile
        require(f.extension.lowercase() in EXTENSIONS) { "plugins must be .apk, .jar, .dex or .zip: ${f.name}" }
        val ok = roots.any { r ->
            val root = r.canonicalFile
            f.path.startsWith(root.path + File.separator)
        }
        require(ok) { "plugins can only be loaded from the app's own folders (projects / files): $f" }
        require(f.isFile) { "plugin not found: $f" }
        return f
    }
}
