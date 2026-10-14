package com.xscript.app.permission

import android.Manifest
import android.app.AppOpsManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Looper
import android.os.Process
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.xscript.app.XscriptApp
import com.xscript.app.runtime.AutomationDispatcher
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Cross-process runtime grant results use a temporary, app-private broadcast receiver. */
object PermissionApi {
    private val ctx: Context get() = XscriptApp.instance
    private val requestLock = Any()
    private val settingsPermissions = mapOf(
        "overlay" to "android.permission.SYSTEM_ALERT_WINDOW",
        "write_settings" to "android.permission.WRITE_SETTINGS",
        "manage_storage" to "android.permission.MANAGE_EXTERNAL_STORAGE",
        "usage_stats" to "android.permission.PACKAGE_USAGE_STATS",
        "install_packages" to "android.permission.REQUEST_INSTALL_PACKAGES",
    )
    private fun supportsSettings(key: String): Boolean = settingsPermissions[key]?.let { it in declared() } ?: true
    private fun runtimeSupported(key: String): Boolean {
        if (key !in declared()) return false
        return try { ctx.packageManager.getPermissionInfo(key, 0); true } catch (_: PackageManager.NameNotFoundException) { false }
    }

    fun call(op: String, a: JSONObject): String = when (op) {
        "permission_has" -> has(a.getString("key")).toString()
        "permission_request" -> request(a.getString("key"), a.optDouble("timeout", 60.0)).toString()
        "permission_list" -> JSONArray(declared().toList().sorted() + PermissionKeys.settings.filter { supportsSettings(it) }.sorted()).toString()
        else -> throw IllegalArgumentException("unknown permission op $op")
    }

    @Suppress("DEPRECATION")
    private fun declared(): Set<String> = ctx.packageManager.getPackageInfo(ctx.packageName, PackageManager.GET_PERMISSIONS)
        .requestedPermissions?.toSet() ?: emptySet()

    @Suppress("DEPRECATION")
    fun has(rawKey: String): Boolean {
        val key = PermissionKeys.normalize(rawKey)
        if (key in PermissionKeys.settings && !supportsSettings(key)) return false
        return when (key) {
            "accessibility" -> AutomationDispatcher.isAccessibilityOn()
            "overlay" -> Settings.canDrawOverlays(ctx)
            "notification_listener" -> NotificationManagerCompat.getEnabledListenerPackages(ctx).contains(ctx.packageName)
            "write_settings" -> Settings.System.canWrite(ctx)
            "manage_storage" -> if (Build.VERSION.SDK_INT >= 30) Environment.isExternalStorageManager() else
                ContextCompat.checkSelfPermission(ctx, Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
            "install_packages" -> ctx.packageManager.canRequestPackageInstalls()
            "usage_stats" -> (ctx.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager)
                .checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), ctx.packageName) == AppOpsManager.MODE_ALLOWED
            else -> key in declared() && ContextCompat.checkSelfPermission(ctx, key) == PackageManager.PERMISSION_GRANTED
        }
    }

    fun request(rawKey: String, timeoutSeconds: Double): Int {
        require(timeoutSeconds.isFinite() && timeoutSeconds > 0 && timeoutSeconds <= 600) { "timeout must be in (0, 600] seconds" }
        val key = PermissionKeys.normalize(rawKey)
        if (has(key)) return PermissionKeys.GRANTED
        if (key in PermissionKeys.settings) return if (supportsSettings(key)) openSettings(key) else PermissionKeys.UNSUPPORTED
        if (!runtimeSupported(key)) return PermissionKeys.UNSUPPORTED
        check(Looper.myLooper() != Looper.getMainLooper()) { "Blocking permission requests must run on a script/worker thread" }
        return synchronized(requestLock) {
            if (has(key)) return@synchronized PermissionKeys.GRANTED
            val action = ctx.packageName + ".PERMISSION_RESULT." + UUID.randomUUID()
            val result = AtomicInteger(PermissionKeys.TIMEOUT)
            val latch = CountDownLatch(1)
            val receiver = object : BroadcastReceiver() {
                override fun onReceive(context: Context?, intent: Intent?) {
                    result.set(intent?.getIntExtra("result", PermissionKeys.DENIED) ?: PermissionKeys.DENIED)
                    latch.countDown()
                }
            }
            ContextCompat.registerReceiver(ctx, receiver, IntentFilter(action), ContextCompat.RECEIVER_NOT_EXPORTED)
            try {
                ctx.startActivity(Intent(ctx, PermissionActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    .putExtra("key", key).putExtra("reply", action)
                    .putExtra("timeout_ms", (timeoutSeconds * 1000).toLong()))
                if (!latch.await((timeoutSeconds * 1000).toLong(), TimeUnit.MILLISECONDS)) PermissionKeys.TIMEOUT
                else if (has(key)) PermissionKeys.GRANTED else result.get().takeUnless { it == PermissionKeys.GRANTED } ?: PermissionKeys.DENIED
            } catch (_: android.content.ActivityNotFoundException) {
                PermissionKeys.UNSUPPORTED
            } finally {
                ctx.unregisterReceiver(receiver)
            }
        }
    }

    private fun openSettings(key: String): Int {
        val uri = Uri.parse("package:" + ctx.packageName)
        val intent = when (key) {
            "accessibility" -> Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
            "notification_listener" -> Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
            "usage_stats" -> Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)
            "overlay" -> Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, uri)
            "write_settings" -> Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS, uri)
            "manage_storage" -> if (Build.VERSION.SDK_INT >= 30) Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, uri)
                else Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, uri)
            "install_packages" -> Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, uri)
            else -> return PermissionKeys.UNSUPPORTED
        }
        return try {
            ctx.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            // Settings grants are nonblocking, as in the inspected Python API.
            PermissionKeys.DENIED
        } catch (_: android.content.ActivityNotFoundException) {
            PermissionKeys.UNSUPPORTED
        }
    }
}
