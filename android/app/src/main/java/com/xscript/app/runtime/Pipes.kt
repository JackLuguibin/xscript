package com.xscript.app.runtime

import android.os.ParcelFileDescriptor
import java.io.ByteArrayOutputStream
import java.io.FileInputStream
import java.io.FileOutputStream
import kotlin.concurrent.thread

/** Stream a payload across processes without hitting the binder size limit. */
object Pipes {
    fun send(bytes: ByteArray): ParcelFileDescriptor {
        val pair = ParcelFileDescriptor.createPipe()
        val write = pair[1]
        thread(name = "xscript-pipe", isDaemon = true) {
            try {
                FileOutputStream(write.fileDescriptor).use { it.write(bytes) }
            } catch (_: Exception) {
            } finally {
                try {
                    write.close()
                } catch (_: Exception) {
                }
            }
        }
        return pair[0]
    }

    fun receive(pfd: ParcelFileDescriptor?): ByteArray {
        if (pfd == null) return ByteArray(0)
        return try {
            FileInputStream(pfd.fileDescriptor).use { input ->
                val out = ByteArrayOutputStream()
                input.copyTo(out, 1 shl 16)
                out.toByteArray()
            }
        } finally {
            try {
                pfd.close()
            } catch (_: Exception) {
            }
        }
    }
}
