package com.xscript.app.permission

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings as AndroidSettings
import com.xscript.app.R
import com.xscript.app.a11y.AccessibilityEngine
import com.xscript.app.capture.CaptureEngine
import com.xscript.app.project.PermissionNeeds.Kind
import com.xscript.app.root.RootShell
import com.xscript.app.settings.Settings
import com.xscript.app.ui.FloatControl

/** Is a permission a project needs in place right now, and where does the user fix it. */
object PermissionStatus {
    fun ok(ctx: Context, kind: Kind): Boolean = when (kind) {
        // Root can tap and type too, unless the run mode is accessibility-only.
        Kind.ACCESSIBILITY -> AccessibilityEngine.isOn() ||
            (Settings.runMode != Settings.MODE_ACCESSIBILITY && RootShell.known() == true)
        Kind.CAPTURE -> CaptureEngine.available()
        Kind.OVERLAY -> FloatControl.canShow(ctx)
        Kind.NOTIFICATIONS -> androidx.core.app.NotificationManagerCompat.getEnabledListenerPackages(ctx).contains(ctx.packageName)
        Kind.STORAGE -> Build.VERSION.SDK_INT < 30 || Environment.isExternalStorageManager()
    }

    /** Status text for the row: what is in place, or what to do. */
    fun label(ctx: Context, kind: Kind): String = when {
        kind == Kind.CAPTURE && CaptureEngine.lost && !ok(ctx, kind) -> "已失效，点此重新授权"
        kind == Kind.CAPTURE && ok(ctx, kind) -> when {
            CaptureEngine.granted -> "系统录屏"
            AccessibilityEngine.isOn() && Build.VERSION.SDK_INT >= 30 -> "无障碍截图"
            else -> "Root截图"
        }
        kind == Kind.ACCESSIBILITY && ok(ctx, kind) && !AccessibilityEngine.isOn() -> "用 Root"
        ok(ctx, kind) -> "已开启"
        else -> "未开启，点此开启"
    }

    fun icon(kind: Kind): Int = when (kind) {
        Kind.ACCESSIBILITY -> R.drawable.ic_sym_accessibility_new
        Kind.CAPTURE -> R.drawable.ic_sym_screenshot_monitor
        Kind.OVERLAY -> R.drawable.ic_sym_layers
        Kind.NOTIFICATIONS -> R.drawable.ic_sym_notifications
        Kind.STORAGE -> R.drawable.ic_sym_folder
    }

    /** Settings screen that grants [kind]; null for screen capture (the caller asks MediaProjection itself). */
    fun settingsIntent(ctx: Context, kind: Kind): Intent? = when (kind) {
        Kind.ACCESSIBILITY -> Intent(AndroidSettings.ACTION_ACCESSIBILITY_SETTINGS)
        Kind.CAPTURE -> null
        Kind.OVERLAY -> FloatControl.permissionIntent(ctx)
        Kind.NOTIFICATIONS -> Intent(AndroidSettings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
        Kind.STORAGE -> if (Build.VERSION.SDK_INT >= 30) {
            Intent(AndroidSettings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:" + ctx.packageName))
        } else null
    }
}
