package com.xscript.app.capture

import java.nio.ByteBuffer

/** Row copies for ImageReader planes whose rows are padded past the visible width. */
object FrameRows {
    /**
     * Copies [height] rows of [rowBytes] bytes from [src] (rows [rowStride] apart, starting at
     * its position 0) into [dst] back to back. [dst] is cleared first and left rewound, ready
     * for `Bitmap.copyPixelsFromBuffer`.
     */
    fun pack(src: ByteBuffer, rowStride: Int, rowBytes: Int, height: Int, dst: ByteBuffer) {
        require(rowStride >= rowBytes) { "rowStride $rowStride < rowBytes $rowBytes" }
        require(dst.capacity() >= rowBytes * height) { "destination too small" }
        dst.clear()
        val view = src.duplicate()
        for (y in 0 until height) {
            val start = y * rowStride
            view.limit(start + rowBytes)
            view.position(start)
            dst.put(view)
        }
        dst.flip()
    }
}
