package com.xscript.app.net

import android.content.Context
import android.net.wifi.WifiManager
import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.Locale

object NetworkInfo {
    /** Preferred port. AScript uses the same default, so the server falls back upward. */
    const val DEFAULT_PORT = 9096
    const val MAX_PORT = 9105

    /** Port the server actually bound (DEFAULT_PORT until the server starts). */
    @Volatile
    var boundPort: Int = DEFAULT_PORT

    val PORT: Int get() = boundPort

    fun localIp(context: Context): String {
        try {
            val wm = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            @Suppress("DEPRECATION")
            val ip = wm.connectionInfo.ipAddress
            if (ip != 0) {
                return String.format(
                    Locale.US,
                    "%d.%d.%d.%d",
                    ip and 0xff,
                    ip shr 8 and 0xff,
                    ip shr 16 and 0xff,
                    ip shr 24 and 0xff,
                )
            }
        } catch (_: Exception) {
        }
        try {
            val interfaces = NetworkInterface.getNetworkInterfaces() ?: return "127.0.0.1"
            for (nif in interfaces) {
                val addrs = nif.inetAddresses
                while (addrs.hasMoreElements()) {
                    val addr = addrs.nextElement()
                    if (!addr.isLoopbackAddress && addr is Inet4Address) {
                        return addr.hostAddress ?: continue
                    }
                }
            }
        } catch (_: Exception) {
        }
        return "127.0.0.1"
    }
}
