package com.xscript.app.capture

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import com.xscript.app.LauncherActivity
import com.xscript.app.R

/** "图色权限已失效" notification; tapping it opens the home screen and asks for the grant again. */
object CaptureNotice {
    private const val CHANNEL = "xscript.capture"
    private const val NOTIF_ID = 9861
    const val EXTRA_REQUEST_CAPTURE = "request_capture"

    const val TITLE = "图色权限已失效"
    const val TEXT = "手机重启或系统收回了录屏授权，找图找色可能失败或变慢。点此重新授权。"

    fun show(context: Context) {
        val mgr = context.getSystemService(NotificationManager::class.java) ?: return
        if (Build.VERSION.SDK_INT >= 26) {
            mgr.createNotificationChannel(
                NotificationChannel(CHANNEL, "图色权限提醒", NotificationManager.IMPORTANCE_DEFAULT),
            )
        }
        val open = PendingIntent.getActivity(
            context,
            NOTIF_ID,
            Intent(context, LauncherActivity.home(context))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(EXTRA_REQUEST_CAPTURE, true),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle(TITLE)
            .setContentText(TEXT)
            .setStyle(NotificationCompat.BigTextStyle().bigText(TEXT))
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        try {
            mgr.notify(NOTIF_ID, n)
        } catch (_: SecurityException) {
            // No notification permission: the home screen row still says it.
        }
    }

    fun cancel(context: Context) {
        context.getSystemService(NotificationManager::class.java)?.cancel(NOTIF_ID)
    }
}
