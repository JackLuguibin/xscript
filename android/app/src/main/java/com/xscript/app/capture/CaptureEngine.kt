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
import com.xscript.app.runtime.FrameCodec
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

    private val grant by lazy {
        CaptureGrant(
            object : CaptureGrant.Store {
                override var wasGranted: Boolean
                    get() = Settings.captureWasGranted
                    set(value) {
                        Settings.captureWasGranted = value
                    }
            },
        )
    }

    /** True when a system recording grant went away without the user asking (reboot, revoked). */
    val lost: Boolean get() = grant.lost

    /** Main process start: report a grant that did not survive the restart. */
    fun checkAfterProcessStart(context: Context) {
        if (grant.onProcessStart(granted)) CaptureNotice.show(context)
    }

    @Volatile
    var lastSource: String = ""
        private set

    // MediaProjection only delivers a new Image when the screen changes. Keep the last
    // frame so a static screen still yields a bitmap. The bitmap (and the row-packing buffer
    // used when the ImageReader pads its rows) is reused across frames: allocating ~10 MB
    // per frame made capture latency spike whenever the screen was changing.
    private var lastProjectionFrame: Bitmap? = null
    private var packBuffer: ByteBuffer? = null
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
        val app = context.applicationContext
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
                    // A projection this object already let go of (stop() before a new grant) is not a loss.
                    if (projection !== proj) return
                    release()
                    if (grant.onSystemStopped()) CaptureNotice.show(app)
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
        grant.onGranted()
        CaptureNotice.cancel(app)
    }

    fun stop() {
        val old = projection
        release()
        grant.onAppStopped()
        try {
            old?.stop()
        } catch (_: Exception) {
        }
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
        synchronized(lock) {
            return latestProjectionFrameLocked()?.copy(Bitmap.Config.ARGB_8888, false)
        }
    }

    /** Newest projection frame (owned by this object; never recycle it). Caller holds [lock]. */
    private fun latestProjectionFrameLocked(): Bitmap? {
        val imgReader = reader ?: return null
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
                storeImage(retry)
            }
            return lastProjectionFrame
        }
        storeImage(image)
        return lastProjectionFrame
    }

    /**
     * Encoded frame ([FrameCodec] layout) straight from the projection frame, cropped to
     * [l,t,r,b]; null when MediaProjection is not the active source (callers fall back to
     * [captureBitmap]). Skips the defensive bitmap copy that [captureBitmap] makes.
     */
    fun encodeFrame(l: Int, t: Int, r: Int, b: Int): ByteArray? {
        if (!granted) return null
        synchronized(lock) {
            val frame = latestProjectionFrameLocked() ?: return null
            lastSource = SOURCE_PROJECTION
            val cropped = FrameCodec.crop(frame, l, t, r, b)
            return try {
                FrameCodec.encode(cropped)
            } finally {
                if (cropped !== frame) cropped.recycle()
            }
        }
    }

    private fun storeImage(image: android.media.Image) {
        image.use { img ->
            val plane = img.planes[0]
            val w = img.width
            val h = img.height
            val rowBytes = w * plane.pixelStride
            var bmp = lastProjectionFrame
            if (bmp == null || bmp.width != w || bmp.height != h || !bmp.isMutable) {
                bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
                lastProjectionFrame = bmp
            }
            val src = plane.buffer
            if (plane.rowStride == rowBytes) {
                src.rewind()
                bmp.copyPixelsFromBuffer(src)
            } else {
                var packed = packBuffer
                if (packed == null || packed.capacity() != rowBytes * h) {
                    packed = ByteBuffer.allocateDirect(rowBytes * h)
                    packBuffer = packed
                }
                FrameRows.pack(src, plane.rowStride, rowBytes, h, packed!!)
                bmp.copyPixelsFromBuffer(packed)
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
        lost -> "已失效，点此重新授权"
        lastSource == SOURCE_ROOT && RootShell.known() == true -> "Root截图"
        Settings.runMode == Settings.MODE_ROOT && RootShell.known() == true -> "Root截图"
        AccessibilityEngine.isOn() && android.os.Build.VERSION.SDK_INT >= 30 -> "无障碍截图"
        RootShell.known() == true -> "Root截图"
        else -> "未授权"
    }

    /** For scripts (`capture_status`): why a capture may have come back empty. */
    fun status(): org.json.JSONObject = org.json.JSONObject()
        .put("granted", granted)
        .put("lost", lost)
        .put("available", available())
        .put("source", lastSource)

    const val RESULT_OK = Activity.RESULT_OK
}
