package com.xscript.app.http

import android.net.LocalServerSocket
import android.net.LocalSocket
import android.util.Log
import org.json.JSONObject
import kotlin.concurrent.thread

/**
 * Hands the pairing code to a computer over USB, so ADB connections pair with no typing. The desktop runs
 *
 *   adb forward tcp:0 localabstract:xscript-pair.<applicationId>
 *
 * and reads one JSON line. Only the adb daemon (uid shell, or root on a rooted/emulator adbd) gets the code;
 * other apps on the phone can connect to an abstract socket too, but their uid is refused.
 */
class PairingSocket(packageName: String) {
    val name = "xscript-pair.$packageName"

    @Volatile
    private var server: LocalServerSocket? = null

    fun start() {
        if (server != null) return
        val s = try {
            LocalServerSocket(name)
        } catch (e: java.io.IOException) {
            Log.w(TAG, "pairing socket unavailable: ${e.message}")
            return
        }
        server = s
        thread(name = "xscript-pair", isDaemon = true) {
            while (server === s) {
                val client = try {
                    s.accept()
                } catch (_: java.io.IOException) {
                    break
                }
                serve(client)
            }
        }
    }

    fun stop() {
        val s = server ?: return
        server = null
        try {
            s.close()
        } catch (_: java.io.IOException) {
        }
    }

    private fun serve(client: LocalSocket) {
        client.use { c ->
            try {
                val uid = c.peerCredentials.uid
                val line = reply(uid, Pairing.required) { Pairing.code }
                c.outputStream.write((line + "\n").toByteArray(Charsets.UTF_8))
                c.outputStream.flush()
            } catch (e: java.io.IOException) {
                Log.w(TAG, "pairing socket: ${e.message}")
            }
        }
    }

    companion object {
        private const val TAG = "PairingSocket"
        const val SHELL_UID = 2000
        const val ROOT_UID = 0

        /** The JSON line for a peer: the code for adbd only. */
        fun reply(uid: Int, required: Boolean, code: () -> String): String {
            if (uid != SHELL_UID && uid != ROOT_UID) return JSONObject().put("error", "adb only").toString()
            val o = JSONObject().put("required", required)
            if (required) o.put("code", code())
            return o.toString()
        }
    }
}
