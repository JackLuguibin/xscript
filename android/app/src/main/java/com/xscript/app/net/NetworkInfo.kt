package com.xscript.app.net

import android.content.Context
import android.net.wifi.WifiManager
import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.Locale

object NetworkInfo {
    /**
     * Preferred port. Deliberately away from AScript's 9096 (and the ports it falls back to),
     * so both apps can run side by side and `adb forward` never hits the wrong one.
     * If 9860 is taken the server tries the next ports up to [MAX_PORT].
     */
    const val DEFAULT_PORT = 9860
    const val MAX_PORT = 9869

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
