package com.xscript.app.capture

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.SystemClock
import com.xscript.app.a11y.AccessibilityEngine
import com.xscript.app.root.RootShell
import com.xscript.app.settings.Settings
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Screen capture in the main process. Source order: MediaProjection (fast, needs a one-time
 * grant) → accessibility screenshot (API 30+, throttled by the system to ~3 fps) → root
 * `screencap` (raw RGBA, no PNG encode).
 */
object CaptureEngine {
    const val SOURCE_PROJECTION = "projection"
    const val SOURCE_ACCESSIBILITY = "accessibility"
    const val SOURCE_ROOT = "root"

    @Volatile
    private var projection: MediaProjection? = null

    @Volatile
    private var reader: ImageReader? = null

    @Volatile
    private var display: VirtualDisplay? = null

    @Volatile
    var granted: Boolean = false
        private set

    @Volatile
    var lastSource: String = ""
        private set

    // MediaProjection only delivers a new Image when the screen changes. Keep the last
    // frame so a static screen still yields a bitmap.
    private var lastProjectionFrame: Bitmap? = null
    private val lock = Any()

    private var lastA11yShotAt = 0L
    private const val A11Y_INTERVAL_MS = 340L

    // Set when the accessibility screenshot proved to be blank while root was not.
    @Volatile
    private var a11yBlankUntil = 0L
    private const val A11Y_BLANK_BACKOFF_MS = 10 * 60_000L

    /** True if a sparse 12x12 sample grid is entirely pure black. */
    private fun isBlank(bmp: Bitmap): Boolean {
        val w = bmp.width
        val h = bmp.height
        if (w <= 0 || h <= 0) return true
        for (i in 0 until 12) {
            for (j in 0 until 12) {
                val px = bmp.getPixel((w * (2 * i + 1)) / 24, (h * (2 * j + 1)) / 24)
                if (px and 0x00FFFFFF != 0) return false
            }
        }
        return true
    }

    private val thread = HandlerThread("xscript-capture").apply { start() }
    private val handler = Handler(thread.looper)

    fun start(context: Context, resultCode: Int, data: Intent) {
        stop()
        val mgr = context.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val proj = mgr.getMediaProjection(resultCode, data) ?: return
        val metrics = context.resources.displayMetrics
        val imgReader = ImageReader.newInstance(
            metrics.widthPixels,
            metrics.heightPixels,
            PixelFormat.RGBA_8888,
            2,
        )
        proj.registerCallback(
            object : MediaProjection.Callback() {
                override fun onStop() {
                    granted = false
                    release()
                }
            },
            Handler(Looper.getMainLooper()),
        )
        val vd = proj.createVirtualDisplay(
            "xscript-cap",
            metrics.widthPixels,
            metrics.heightPixels,
            metrics.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            imgReader.surface,
            null,
            handler,
        )
        projection = proj
        reader = imgReader
        display = vd
        granted = true
    }

    fun stop() {
        try {
            projection?.stop()
        } catch (_: Exception) {
        }
        release()
    }

    private fun release() {
        try {
            display?.release()
        } catch (_: Exception) {
        }
        try {
            reader?.close()
        } catch (_: Exception) {
        }
        display = null
        reader = null
        projection = null
        granted = false
        synchronized(lock) { lastProjectionFrame = null }
    }

    fun captureBitmap(): Bitmap? {
        val mode = Settings.runMode
        if (granted) {
            projectionFrame()?.let {
                lastSource = SOURCE_PROJECTION
                return it
            }
        }
        val a11yUsable = SystemClock.uptimeMillis() >= a11yBlankUntil
        if (a11yUsable && mode != Settings.MODE_ROOT && AccessibilityEngine.isOn() &&
            android.os.Build.VERSION.SDK_INT >= 30
        ) {
            val frame = accessibilityFrame()
            if (frame != null) {
                // Some emulators (MuMu, LDPlayer) hand back an all-black hardware buffer.
                // If root can do better, stop trusting accessibility screenshots for a while.
                if (isBlank(frame) && mode != Settings.MODE_ACCESSIBILITY && RootShell.known() == true) {
                    val root = rootFrame()
                    if (root != null && !isBlank(root)) {
                        frame.recycle()
                        a11yBlankUntil = SystemClock.uptimeMillis() + A11Y_BLANK_BACKOFF_MS
                        lastSource = SOURCE_ROOT
                        return root
                    }
                    root?.recycle()
                }
                lastSource = SOURCE_ACCESSIBILITY
                return frame
            }
        }
        if (mode != Settings.MODE_ACCESSIBILITY && RootShell.known() == true) {
            rootFrame()?.let {
                lastSource = SOURCE_ROOT
                return it
            }
        }
        return null
    }

    private fun projectionFrame(): Bitmap? {
        val imgReader = reader ?: return null
        synchronized(lock) {
            val image = try {
                imgReader.acquireLatestImage()
            } catch (_: Exception) {
                null
            }
            if (image == null) {
                if (lastProjectionFrame == null) {
                    // First call right after the grant: give the virtual display a moment.
                    SystemClock.sleep(120)
                    val retry = try {
                        imgReader.acquireLatestImage()
                    } catch (_: Exception) {
                        null
                    } ?: return null
                    lastProjectionFrame = imageToBitmap(retry)
                }
                return lastProjectionFrame?.copy(Bitmap.Config.ARGB_8888, false)
            }
            lastProjectionFrame = imageToBitmap(image)
            return lastProjectionFrame?.copy(Bitmap.Config.ARGB_8888, false)
        }
    }

    private fun imageToBitmap(image: android.media.Image): Bitmap {
        image.use { img ->
            val plane = img.planes[0]
            val pixelStride = plane.pixelStride
            val rowStride = plane.rowStride
            val rowPadding = rowStride - pixelStride * img.width
            val bitmap = Bitmap.createBitmap(
                img.width + rowPadding / pixelStride,
                img.height,
                Bitmap.Config.ARGB_8888,
            )
            bitmap.copyPixelsFromBuffer(plane.buffer)
            return if (rowPadding == 0) {
                bitmap
            } else {
                Bitmap.createBitmap(bitmap, 0, 0, img.width, img.height).also { bitmap.recycle() }
            }
        }
    }

    @Synchronized
    private fun accessibilityFrame(): Bitmap? {
        val wait = A11Y_INTERVAL_MS - (SystemClock.uptimeMillis() - lastA11yShotAt)
        if (wait > 0) SystemClock.sleep(wait)
        val bmp = try {
            AccessibilityEngine.takeScreenshotBitmap()
        } catch (_: Throwable) {
            null
        }
        lastA11yShotAt = SystemClock.uptimeMillis()
        return bmp
    }

    /** `screencap` without -p writes a small header followed by raw RGBA pixels. */
    private fun rootFrame(): Bitmap? {
        val raw = try {
            RootShell.execRaw("screencap", 10_000)
        } catch (_: Exception) {
            return null
        }
        val bytes = raw.out
        if (raw.code != 0 || bytes.size < 16) return null
        val head = ByteBuffer.wrap(bytes, 0, 16).order(ByteOrder.LITTLE_ENDIAN)
        val w = head.getInt(0)
        val h = head.getInt(4)
        if (w <= 0 || h <= 0) return null
        val pixels = w.toLong() * h * 4
        val offset = (bytes.size - pixels).toInt()
        if (offset < 12 || offset > 16) return null
        val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        bitmap.copyPixelsFromBuffer(ByteBuffer.wrap(bytes, offset, pixels.toInt()))
        return bitmap
    }

    fun captureToFile(context: Context, path: String?): String? {
        val bitmap = captureBitmap() ?: return null
        val target = if (path.isNullOrBlank()) {
            File(context.filesDir, "shots/latest.png")
        } else {
            File(path)
        }
        target.parentFile?.mkdirs()
        FileOutputStream(target).use { out ->
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
        }
        bitmap.recycle()
        return target.absolutePath
    }

    fun available(): Boolean =
        granted || (AccessibilityEngine.isOn() && android.os.Build.VERSION.SDK_INT >= 30) || RootShell.known() == true

    /** Label for the home screen "图色权限" row. */
    fun sourceLabel(): String = when {
        granted -> "系统录屏"
        lastSource == SOURCE_ROOT && RootShell.known() == true -> "Root截图"
        Settings.runMode == Settings.MODE_ROOT && RootShell.known() == true -> "Root截图"
        AccessibilityEngine.isOn() && android.os.Build.VERSION.SDK_INT >= 30 -> "无障碍截图"
        RootShell.known() == true -> "Root截图"
        else -> "未授权"
    }

    const val RESULT_OK = Activity.RESULT_OK
}
