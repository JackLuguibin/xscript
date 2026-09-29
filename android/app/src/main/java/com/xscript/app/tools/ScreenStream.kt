package com.xscript.app.tools

import android.graphics.Bitmap
import com.xscript.app.capture.CaptureEngine
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.PipedInputStream
import java.io.PipedOutputStream
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/**
 * 投屏: MJPEG (`multipart/x-mixed-replace`) stream of the screen, viewable in an `<img>`.
 *
 * A producer thread captures, scales and JPEG-encodes frames into a pipe that the HTTP
 * server streams to the client. When the client goes away the server closes the pipe,
 * the next write fails and the producer stops. The frame rate is best effort: root
 * `screencap` alone takes ~400 ms per frame, MediaProjection is much faster.
 */
object ScreenStream {
    const val BOUNDARY = "xscriptframe"
    const val MIME = "multipart/x-mixed-replace; boundary=$BOUNDARY"
    private const val MAX_STREAMS = 2

    private val active = AtomicInteger(0)

    data class Options(val fps: Int, val quality: Int, val scale: Float) {
        companion object {
            fun from(query: Map<String, String>) = Options(
                fps = query["fps"]?.toIntOrNull()?.coerceIn(1, 15) ?: 5,
                quality = query["quality"]?.toIntOrNull()?.coerceIn(10, 95) ?: 50,
                scale = query["scale"]?.toFloatOrNull()?.coerceIn(0.2f, 1f) ?: 0.5f,
            )
        }
    }

    /** Stream to hand to the HTTP server, or null when too many viewers are connected. */
    fun open(opts: Options): InputStream? {
        if (active.incrementAndGet() > MAX_STREAMS) {
            active.decrementAndGet()
            return null
        }
        val input = PipedInputStream(512 * 1024)
        val out = PipedOutputStream(input)
        thread(name = "xscript-mjpeg", isDaemon = true) {
            try {
                produce(out, opts)
            } catch (_: IOException) {
                // Client disconnected.
            } finally {
                try {
                    out.close()
                } catch (_: IOException) {
                }
                active.decrementAndGet()
            }
        }
        return input
    }

    private fun produce(out: PipedOutputStream, opts: Options) {
        val frameMs = 1000L / opts.fps
        val jpeg = ByteArrayOutputStream(256 * 1024)
        while (true) {
            val started = System.currentTimeMillis()
            val frame = CaptureEngine.captureBitmap()
            if (frame == null) {
                Thread.sleep(500)
                continue
            }
            val scaled = if (opts.scale < 0.99f) {
                val w = (frame.width * opts.scale).toInt().coerceAtLeast(1)
                val h = (frame.height * opts.scale).toInt().coerceAtLeast(1)
                Bitmap.createScaledBitmap(frame, w, h, true)
            } else {
                frame
            }
            jpeg.reset()
            scaled.compress(Bitmap.CompressFormat.JPEG, opts.quality, jpeg)
            if (scaled !== frame) scaled.recycle()
            val fullW = frame.width
            val fullH = frame.height
            frame.recycle()
            // X-Screen-Size lets clients map clicks back to full-resolution coordinates.
            val head = "--$BOUNDARY\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.size()}\r\n" +
                "X-Screen-Size: ${fullW}x$fullH\r\n\r\n"
            out.write(head.toByteArray(Charsets.US_ASCII))
            jpeg.writeTo(out)
            out.write("\r\n".toByteArray(Charsets.US_ASCII))
            out.flush()
            val wait = frameMs - (System.currentTimeMillis() - started)
            if (wait > 0) Thread.sleep(wait)
        }
    }
}
