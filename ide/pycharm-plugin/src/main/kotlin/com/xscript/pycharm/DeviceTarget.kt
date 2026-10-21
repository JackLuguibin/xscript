package com.xscript.pycharm

/** XScript's device port (AScript uses 9096). Same rules as the VS Code extension's parseTarget (client.ts). */
const val DEFAULT_PORT = 9860

data class DeviceTarget(val host: String, val port: Int = DEFAULT_PORT) {
    val baseUrl: String get() = "http://" + (if (':' in host) "[$host]" else host) + ":" + port

    companion object {
        /** Accepts "host", "host:port", "http://host:port/path", "[ipv6]:port" or a bare IPv6 address. */
        fun parse(value: String?): DeviceTarget {
            var text = (value ?: "").trim()
            if (text.isEmpty()) return DeviceTarget("127.0.0.1")
            if ("://" in text) text = text.substringAfter("://")
            text = text.substringBefore('/')
            fun port(s: String): Int {
                if (s.isEmpty()) return DEFAULT_PORT
                val n = if (s.all { it.isDigit() }) s.toIntOrNull() else null
                require(n != null && n in 1..65535) { "invalid port in device address: $value" }
                return n
            }
            if (text.startsWith("[")) {
                val end = text.indexOf(']')
                require(end >= 0) { "invalid device address: $value" }
                val rest = text.substring(end + 1)
                return DeviceTarget(text.substring(1, end).ifEmpty { "::1" }, port(rest.removePrefix(":")))
            }
            if (text.count { it == ':' } > 1) return DeviceTarget(text)
            val i = text.lastIndexOf(':')
            if (i < 0) return DeviceTarget(text)
            return DeviceTarget(text.substring(0, i).ifEmpty { "127.0.0.1" }, port(text.substring(i + 1)))
        }
    }
}
