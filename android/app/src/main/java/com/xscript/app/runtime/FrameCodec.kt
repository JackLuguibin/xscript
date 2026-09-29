package com.xscript.app.runtime

import android.graphics.Bitmap
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Raw frame wire format: 8-byte little-endian header (width, height) followed by the
 * bitmap's native ARGB_8888 bytes (RGBA byte order in memory).
 */
object FrameCodec {
    fun encode(bitmap: Bitmap): ByteArray {
        val src = if (bitmap.config == Bitmap.Config.ARGB_8888) bitmap else bitmap.copy(Bitmap.Config.ARGB_8888, false)
        val size = src.byteCount
        val buf = ByteBuffer.allocate(8 + size).order(ByteOrder.LITTLE_ENDIAN)
        buf.putInt(src.width)
        buf.putInt(src.height)
        src.copyPixelsToBuffer(buf)
        if (src !== bitmap) src.recycle()
        return buf.array()
    }

    fun decode(bytes: ByteArray): Bitmap? {
        if (bytes.size < 8) return null
        val head = ByteBuffer.wrap(bytes, 0, 8).order(ByteOrder.LITTLE_ENDIAN)
        val w = head.getInt()
        val h = head.getInt()
        if (w <= 0 || h <= 0 || bytes.size < 8 + w * h * 4) return null
        val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        bitmap.copyPixelsFromBuffer(ByteBuffer.wrap(bytes, 8, w * h * 4))
        return bitmap
    }

    /** Crop to [l,t,r,b] if the rect is valid, otherwise return the source. */
    fun crop(bitmap: Bitmap, l: Int, t: Int, r: Int, b: Int): Bitmap {
        if (r <= l || b <= t) return bitmap
        val left = l.coerceIn(0, bitmap.width - 1)
        val top = t.coerceIn(0, bitmap.height - 1)
        val right = r.coerceIn(left + 1, bitmap.width)
        val bottom = b.coerceIn(top + 1, bitmap.height)
        if (left == 0 && top == 0 && right == bitmap.width && bottom == bitmap.height) return bitmap
        return Bitmap.createBitmap(bitmap, left, top, right - left, bottom - top)
    }
}
