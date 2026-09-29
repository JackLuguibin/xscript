package com.xscript.app.http

import android.os.SystemClock

/**
 * Remembers the last developer tool (MCP / IDE) that talked to the device, so the home
 * screen can show "AI 编程连接". Clients identify with the `X-XScript-Client` header.
 */
object ClientTracker {
    private const val ACTIVE_MS = 90_000L

    @Volatile
    private var lastClient: String = ""

    @Volatile
    private var lastRemote: String = ""

    @Volatile
    private var lastSeen: Long = 0L

    fun touch(client: String, remote: String) {
        lastClient = client
        lastRemote = remote
        lastSeen = SystemClock.elapsedRealtime()
    }

    /** "mcp@192.168.1.5" while active, null otherwise. */
    fun active(): String? {
        if (lastSeen == 0L || SystemClock.elapsedRealtime() - lastSeen > ACTIVE_MS) return null
        return if (lastRemote.isEmpty()) lastClient else "$lastClient@$lastRemote"
    }
}
