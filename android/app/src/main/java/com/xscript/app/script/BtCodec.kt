package com.xscript.app.script

import java.util.Base64
import java.util.UUID

/** Pure helpers of the bluetooth bridge (JVM-tested): addresses, UUIDs, payload encoding. */
internal object BtCodec {
    /** Serial Port Profile UUID used by classic serial modules (HC-05/HC-06, ESP32 BluetoothSerial). */
    val SPP: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
    private val MAC = Regex("^[0-9A-F]{2}(:[0-9A-F]{2}){5}$")

    fun address(v: String): String {
        val a = v.trim().uppercase().replace('-', ':')
        require(MAC.matches(a)) { "invalid bluetooth address: $v" }
        return a
    }

    /** Full UUID, or a 16/32-bit short form ("180d", "0x2a37") expanded on the Bluetooth base UUID. */
    fun uuid(v: String?): UUID {
        val s = v?.trim()?.lowercase()?.removePrefix("0x").orEmpty()
        if (s.isEmpty()) return SPP
        if (Regex("^[0-9a-f]{4}$|^[0-9a-f]{8}$").matches(s)) return UUID.fromString(s.padStart(8, '0') + "-0000-1000-8000-00805f9b34fb")
        return try { UUID.fromString(s) } catch (e: IllegalArgumentException) { throw IllegalArgumentException("invalid UUID: $v") }
    }

    fun encode(b: ByteArray): String = Base64.getEncoder().encodeToString(b)
    fun decode(s: String): ByteArray = try { Base64.getDecoder().decode(s) } catch (e: IllegalArgumentException) {
        throw IllegalArgumentException("data must be base64")
    }
}
