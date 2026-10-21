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

    const val REQUEST_TITLE = "电脑端请求开启图色权限"
    const val REQUEST_TEXT = "点此在手机上授权录屏，投屏和找图找色才能用。"

    /**
     * Asked from the desktop (POST /capture/request): open the grant dialog now, and post the notification as well in case
     * the system does not let the app come to the front from the background.
     */
    fun request(context: Context): Boolean {
        val started = try {
            context.startActivity(openIntent(context))
            true
        } catch (_: RuntimeException) {
            false
        }
        show(context, REQUEST_TITLE, REQUEST_TEXT)
        return started
    }

    private fun openIntent(context: Context) =
        Intent(context, LauncherActivity.home(context))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(EXTRA_REQUEST_CAPTURE, true)

    fun show(context: Context, title: String = TITLE, text: String = TEXT) {
        val mgr = context.getSystemService(NotificationManager::class.java) ?: return
        if (Build.VERSION.SDK_INT >= 26) {
            mgr.createNotificationChannel(
                NotificationChannel(CHANNEL, "图色权限提醒", NotificationManager.IMPORTANCE_DEFAULT),
            )
        }
        val open = PendingIntent.getActivity(
            context,
            NOTIF_ID,
            openIntent(context),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
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
