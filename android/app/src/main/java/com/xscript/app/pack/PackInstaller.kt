package com.xscript.app.pack

import android.content.Context
import com.xscript.app.BuildConfig
import com.xscript.app.project.ProjectStore
import com.xscript.app.settings.Settings
import java.io.File

/**
 * Packaged apps (APK 打包): the project ships in `assets/pack/<name>/`. On first start, and
 * after every app update (new versionCode), it is copied into the project store, so the
 * normal runner, schedules and 开机自启 all work unchanged.
 */
object PackInstaller {
    val project: String get() = BuildConfig.PACK_PROJECT

    fun isPacked(): Boolean = BuildConfig.PACKAGED && project.isNotEmpty()

    fun ensure(context: Context) {
        if (!isPacked()) return
        val prefs = context.getSharedPreferences("xscript_pack", Context.MODE_PRIVATE)
        val version = versionCode(context)
        val store = ProjectStore(context)
        if (prefs.getLong("installed_version", -1L) == version && store.exists(project)) return
        val target = store.dir(project)
        val staging = File(target.parentFile, ".pack-" + System.nanoTime())
        try {
            copyAssets(context, "pack/$project", staging)
            require(ProjectStore.hasEntry(staging)) { "packed project has no __init__.py" }
            // The shipped copy replaces the old one. Scripts keep state in KeyValue, which is
            // stored outside the project directory.
            target.deleteRecursively()
            target.parentFile?.mkdirs()
            if (!staging.renameTo(target)) {
                staging.copyRecursively(target, overwrite = true)
            }
        } finally {
            staging.deleteRecursively()
        }
        prefs.edit().putLong("installed_version", version).apply()
        // The APK's copy replaced any 热更新 install; the next check fetches the current version again.
        UpdateChecker.resetToBundled(context)
        firstRunDefaults(prefs)
    }

    /** Pack-time defaults, applied once so the user can still change them later. */
    private fun firstRunDefaults(prefs: android.content.SharedPreferences) {
        if (prefs.getBoolean("defaults_applied", false)) return
        Settings.lastProject = project
        if (BuildConfig.PACK_CLOUD_URL.isNotEmpty() && Settings.cloudUrl.isEmpty()) Settings.cloudUrl = BuildConfig.PACK_CLOUD_URL
        if (BuildConfig.PACK_CLOUD_GROUP.isNotEmpty() && Settings.cloudGroup.isEmpty()) Settings.cloudGroup = BuildConfig.PACK_CLOUD_GROUP
        if (BuildConfig.PACK_AUTOSTART) Settings.bootProject = project
        prefs.edit().putBoolean("defaults_applied", true).apply()
    }

    private fun copyAssets(context: Context, path: String, dest: File) {
        val am = context.assets
        val children = am.list(path).orEmpty()
        if (children.isEmpty()) {
            // A file (asset dirs always list children; empty dirs are not packaged).
            dest.parentFile?.mkdirs()
            am.open(path).use { input -> dest.outputStream().use { input.copyTo(it) } }
            return
        }
        dest.mkdirs()
        for (c in children) copyAssets(context, "$path/$c", File(dest, c))
    }

    private fun versionCode(context: Context): Long {
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        return if (android.os.Build.VERSION.SDK_INT >= 28) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()
    }
}
