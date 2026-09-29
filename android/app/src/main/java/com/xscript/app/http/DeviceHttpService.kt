package com.xscript.app.http

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.xscript.app.MainActivity
import com.xscript.app.R
import com.xscript.app.capture.CaptureEngine
import com.xscript.app.net.NetworkInfo
import android.util.Log
import fi.iki.elonen.NanoHTTPD

class DeviceHttpService : Service() {
    private var server: DeviceHttpServer? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
        val notification = notification()
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIF_ID, notification)
        }
        server = startServer()
        if (server != null) {
            getSystemService(NotificationManager::class.java).notify(NOTIF_ID, notification())
        }
    }

    /** Bind the first free port from 9096 upward (AScript also listens on 9096 by default). */
    private fun startServer(): DeviceHttpServer? {
        for (port in NetworkInfo.DEFAULT_PORT..NetworkInfo.MAX_PORT) {
            val http = DeviceHttpServer(this, port)
            try {
                http.start(NanoHTTPD.SOCKET_READ_TIMEOUT, false)
                NetworkInfo.boundPort = port
                return http
            } catch (e: java.io.IOException) {
                Log.w("XScript", "port $port busy: ${e.message}")
            }
        }
        Log.e("XScript", "no free port in ${NetworkInfo.DEFAULT_PORT}..${NetworkInfo.MAX_PORT}")
        return null
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.hasExtra(EXTRA_PROJECTION_DATA) == true) {
            val code = intent.getIntExtra(EXTRA_PROJECTION_CODE, 0)
            val data = intent.getParcelableExtra<Intent>(EXTRA_PROJECTION_DATA)
            if (data != null) {
                if (Build.VERSION.SDK_INT >= 29) {
                    startForeground(
                        NOTIF_ID,
                        notification(),
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC or
                            ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION,
                    )
                }
                CaptureEngine.start(this, code, data)
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        server?.stop()
        server = null
        super.onDestroy()
    }

    private fun notification(): Notification {
        val launch = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val ip = NetworkInfo.localIp(this)
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(getString(R.string.server_notify, ip, NetworkInfo.PORT))
            .setContentIntent(launch)
            .setOngoing(true)
            .build()
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < 26) return
        val mgr = getSystemService(NotificationManager::class.java)
        mgr.createNotificationChannel(
            NotificationChannel(CHANNEL, getString(R.string.server_channel), NotificationManager.IMPORTANCE_LOW),
        )
    }

    companion object {
        private const val CHANNEL = "xscript.server"
        private const val NOTIF_ID = 9096
        const val EXTRA_PROJECTION_CODE = "code"
        const val EXTRA_PROJECTION_DATA = "data"

        fun start(context: Context) {
            val intent = Intent(context, DeviceHttpService::class.java)
            if (Build.VERSION.SDK_INT >= 26) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun deliverProjection(context: Context, resultCode: Int, data: Intent) {
            val intent = Intent(context, DeviceHttpService::class.java).apply {
                putExtra(EXTRA_PROJECTION_CODE, resultCode)
                putExtra(EXTRA_PROJECTION_DATA, data)
            }
            if (Build.VERSION.SDK_INT >= 26) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }
    }
}
