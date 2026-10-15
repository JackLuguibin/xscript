package com.xscript.app.http

/**
 * `GET /screen` query: `format=jpg|jpeg` (else PNG), `quality` 1..100 (JPEG, default 80) and
 * `max` = longest-side limit 64..4096 for small 云控 live frames (never upscales).
 */
data class ScreenOptions(val jpeg: Boolean, val quality: Int, val width: Int, val height: Int) {
    val mime: String get() = if (jpeg) "image/jpeg" else "image/png"

    companion object {
        fun parse(query: Map<String, String>, width: Int, height: Int): ScreenOptions {
            val fmt = query["format"].orEmpty().lowercase()
            val jpeg = fmt == "jpg" || fmt == "jpeg"
            val quality = if (jpeg) query["quality"]?.toIntOrNull()?.coerceIn(1, 100) ?: 80 else 100
            val max = query["max"]?.toIntOrNull()?.coerceIn(64, 4096)
            val scale = if (max != null && width > 0 && height > 0) minOf(1.0, max.toDouble() / maxOf(width, height)) else 1.0
            if (scale >= 1.0) return ScreenOptions(jpeg, quality, width, height)
            return ScreenOptions(jpeg, quality, (width * scale).toInt().coerceAtLeast(1), (height * scale).toInt().coerceAtLeast(1))
        }
    }
}
