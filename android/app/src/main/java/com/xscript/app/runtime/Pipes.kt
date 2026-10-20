package com.xscript.app.runtime

import android.os.ParcelFileDescriptor
import java.io.ByteArrayOutputStream
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
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

    /** Like [receive] for a [FrameCodec] payload: sized from its (w, h) header, read in place. */
    fun receiveFrame(pfd: ParcelFileDescriptor?): ByteArray {
        if (pfd == null) return ByteArray(0)
        return try {
            FileInputStream(pfd.fileDescriptor).use { readFrame(it) }
        } finally {
            try {
                pfd.close()
            } catch (_: Exception) {
            }
        }
    }

    /**
     * Reads an 8-byte little-endian (w, h) header and then exactly w*h*4 pixel bytes into one
     * array (no growing buffer and final copy, ~30 MB of garbage per full frame otherwise).
     * Falls back to reading everything when the header does not describe a frame.
     */
    fun readFrame(input: InputStream): ByteArray {
        val head = ByteArray(8)
        val got = readFully(input, head, 0, 8)
        if (got < 8) return head.copyOf(got)
        val w = (head[0].toInt() and 0xff) or ((head[1].toInt() and 0xff) shl 8) or
            ((head[2].toInt() and 0xff) shl 16) or ((head[3].toInt() and 0xff) shl 24)
        val h = (head[4].toInt() and 0xff) or ((head[5].toInt() and 0xff) shl 8) or
            ((head[6].toInt() and 0xff) shl 16) or ((head[7].toInt() and 0xff) shl 24)
        val size = 8L + w.toLong() * h.toLong() * 4L
        if (w <= 0 || h <= 0 || size > Int.MAX_VALUE - 16) {
            val out = ByteArrayOutputStream()
            out.write(head)
            input.copyTo(out, 1 shl 16)
            return out.toByteArray()
        }
        val buf = ByteArray(size.toInt())
        System.arraycopy(head, 0, buf, 0, 8)
        val n = readFully(input, buf, 8, buf.size - 8)
        return if (n == buf.size - 8) buf else buf.copyOf(8 + n)
    }

    private fun readFully(input: InputStream, buf: ByteArray, off: Int, len: Int): Int {
        var done = 0
        while (done < len) {
            val n = input.read(buf, off + done, len - done)
            if (n < 0) break
            done += n
        }
        return done
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
