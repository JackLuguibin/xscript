package com.xscript.app.a11y

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.view.Display
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.math.max

object AccessibilityEngine {
    @Volatile
    private var service: XscriptAccessibilityService? = null

    private val screenshotExecutor = Executors.newSingleThreadExecutor()

    @Volatile
    var foregroundPackage: String = ""
        private set

    @Volatile
    var foregroundActivity: String = ""
        private set

    // Touch.down/move/up state. Continued strokes need the previous stroke object.
    private var touchStroke: GestureDescription.StrokeDescription? = null
    private var touchX = 0f
    private var touchY = 0f

    fun attach(svc: XscriptAccessibilityService) {
        service = svc
    }

    fun detach() {
        service = null
    }

    fun isOn(): Boolean = service != null

    fun onWindowChanged(pkg: String?, cls: String?) {
        if (pkg.isNullOrEmpty()) return
        if (pkg == service?.packageName) return
        foregroundPackage = pkg
        // Only activity-like class names; widget classes arrive for popups and toasts.
        if (!cls.isNullOrEmpty() && !cls.startsWith("android.widget.") && !cls.startsWith("android.view.")) {
            foregroundActivity = cls
        }
    }

    fun dump(mode: Int): JSONObject {
        val svc = service ?: return JSONObject()
            .put("mode", mode)
            .put("width", 0)
            .put("height", 0)
            .put("roots", JSONArray())
            .put("error", "accessibility_off")
        val size = com.xscript.app.util.DisplaySize.real(svc)
        val roots = NodeDumper.collectRoots(svc, mode, svc.packageName)
        return try {
            NodeDumper.dump(roots, mode, size.x, size.y)
        } finally {
            roots.forEach { it.node.recycleCompat() }
        }
    }

    fun click(x: Int, y: Int, durMs: Int): Boolean {
        val path = Path().apply { moveTo(x.toFloat(), y.toFloat()) }
        val stroke = GestureDescription.StrokeDescription(path, 0, max(1, durMs).toLong())
        return dispatch(GestureDescription.Builder().addStroke(stroke).build())
    }

    fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, durMs: Int): Boolean {
        val path = Path().apply {
            moveTo(x1.toFloat(), y1.toFloat())
            lineTo(x2.toFloat(), y2.toFloat())
        }
        val stroke = GestureDescription.StrokeDescription(path, 0, max(10, durMs).toLong())
        return dispatch(GestureDescription.Builder().addStroke(stroke).build())
    }

    /**
     * strokes: [{"start":0,"duration":300,"points":[[x,y],[x,y],...]}, ...]
     * Up to 10 strokes run in parallel (multi-finger).
     */
    fun gesture(strokesJson: String): Boolean {
        val arr = JSONArray(strokesJson)
        if (arr.length() == 0) return false
        val builder = GestureDescription.Builder()
        for (i in 0 until minOf(arr.length(), GestureDescription.getMaxStrokeCount())) {
            val s = arr.getJSONObject(i)
            val pts = s.getJSONArray("points")
            if (pts.length() == 0) continue
            val path = Path()
            for (p in 0 until pts.length()) {
                val pt = pts.getJSONArray(p)
                val x = pt.getDouble(0).toFloat()
                val y = pt.getDouble(1).toFloat()
                if (p == 0) path.moveTo(x, y) else path.lineTo(x, y)
            }
            val start = s.optLong("start", 0L).coerceAtLeast(0L)
            val duration = s.optLong("duration", 300L).coerceAtLeast(1L)
            builder.addStroke(GestureDescription.StrokeDescription(path, start, duration))
        }
        return dispatch(builder.build())
    }

    /** action: 0 down, 1 move, 2 up. Requires API 26 continued strokes. */
    @Synchronized
    fun touch(action: Int, x: Int, y: Int, durMs: Int): Boolean {
        if (Build.VERSION.SDK_INT < 26) return false
        val fx = x.toFloat()
        val fy = y.toFloat()
        val dur = max(1, durMs).toLong()
        val stroke: GestureDescription.StrokeDescription = when (action) {
            0 -> {
                val p = Path().apply { moveTo(fx, fy) }
                GestureDescription.StrokeDescription(p, 0, dur, true)
            }
            else -> {
                val prev = touchStroke ?: return false
                val p = Path().apply {
                    moveTo(touchX, touchY)
                    lineTo(fx, fy)
                }
                prev.continueStroke(p, 0, dur, action != 2)
            }
        }
        touchX = fx
        touchY = fy
        touchStroke = if (action == 2) null else stroke
        return dispatch(GestureDescription.Builder().addStroke(stroke).build())
    }

    fun nodeAction(path: String, action: String, arg: String): Boolean {
        val svc = service ?: return false
        val roots = NodeDumper.collectRoots(svc, NodeDumper.MODE_FULL, svc.packageName)
        try {
            val node = NodeDumper.findByPath(roots, path) ?: return false
            try {
                return performOn(node, action, arg)
            } finally {
                node.recycleCompat()
            }
        } finally {
            roots.forEach { it.node.recycleCompat() }
        }
    }

    private fun performOn(node: AccessibilityNodeInfo, action: String, arg: String): Boolean {
        val rect = Rect()
        node.getBoundsInScreen(rect)
        return when (action) {
            "click" -> {
                if (node.isClickable && node.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                    true
                } else {
                    click(rect.centerX(), rect.centerY(), 20)
                }
            }
            "long_click" -> {
                if (node.isLongClickable && node.performAction(AccessibilityNodeInfo.ACTION_LONG_CLICK)) {
                    true
                } else {
                    click(rect.centerX(), rect.centerY(), 700)
                }
            }
            "set_text" -> applyText(node, arg)
            "focus" -> node.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
            "scroll_forward" -> scrollable(node)?.let {
                try {
                    it.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD)
                } finally {
                    if (it !== node) it.recycleCompat()
                }
            } ?: false
            "scroll_backward" -> scrollable(node)?.let {
                try {
                    it.performAction(AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD)
                } finally {
                    if (it !== node) it.recycleCompat()
                }
            } ?: false
            else -> false
        }
    }

    private fun scrollable(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        if (node.isScrollable) return node
        var cur: AccessibilityNodeInfo? = node.parent
        while (cur != null) {
            if (cur.isScrollable) return cur
            val next = cur.parent
            cur.recycleCompat()
            cur = next
        }
        return null
    }

    fun inputText(text: String): Boolean {
        val svc = service ?: return false
        val roots = NodeDumper.collectRoots(svc, NodeDumper.MODE_FULL, svc.packageName)
        try {
            for (root in roots) {
                val focused = root.node.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
                val target = focused ?: NodeDumper.firstEditable(root.node)
                if (target != null) {
                    try {
                        if (applyText(target, text)) return true
                    } finally {
                        target.recycleCompat()
                    }
                }
            }
        } finally {
            roots.forEach { it.node.recycleCompat() }
        }
        return false
    }

    fun globalAction(name: String): Boolean {
        val svc = service ?: return false
        val id = when (name) {
            "back" -> AccessibilityService.GLOBAL_ACTION_BACK
            "home" -> AccessibilityService.GLOBAL_ACTION_HOME
            "recents" -> AccessibilityService.GLOBAL_ACTION_RECENTS
            "notifications" -> AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS
            "quick_settings" -> AccessibilityService.GLOBAL_ACTION_QUICK_SETTINGS
            "power_dialog" -> AccessibilityService.GLOBAL_ACTION_POWER_DIALOG
            "lock_screen" -> if (Build.VERSION.SDK_INT >= 28) AccessibilityService.GLOBAL_ACTION_LOCK_SCREEN else return false
            "screenshot" -> if (Build.VERSION.SDK_INT >= 28) AccessibilityService.GLOBAL_ACTION_TAKE_SCREENSHOT else return false
            else -> return false
        }
        return svc.performGlobalAction(id)
    }

    fun takeScreenshotBitmap(): Bitmap? {
        val svc = service ?: return null
        if (Build.VERSION.SDK_INT < 30) return null
        val latch = CountDownLatch(1)
        var bitmap: Bitmap? = null
        // Throws SecurityException when the service config lacks canTakeScreenshot
        // (e.g. an old enabled-service binding); callers fall through to root capture.
        try { svc.takeScreenshot(
            Display.DEFAULT_DISPLAY,
            screenshotExecutor,
            object : AccessibilityService.TakeScreenshotCallback {
                override fun onSuccess(result: AccessibilityService.ScreenshotResult) {
                    val buffer = result.hardwareBuffer
                    bitmap = Bitmap.wrapHardwareBuffer(buffer, result.colorSpace)
                        ?.copy(Bitmap.Config.ARGB_8888, false)
                    buffer.close()
                    latch.countDown()
                }

                override fun onFailure(errorCode: Int) {
                    latch.countDown()
                }
            },
        ) } catch (_: Throwable) {
            return null
        }
        latch.await(3, TimeUnit.SECONDS)
        return bitmap
    }

    private fun applyText(node: AccessibilityNodeInfo, text: String): Boolean {
        node.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }
        return node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
    }

    private fun dispatch(gesture: GestureDescription): Boolean {
        val svc = service ?: return false
        val latch = CountDownLatch(1)
        var ok = false
        val sent = svc.dispatchGesture(
            gesture,
            object : AccessibilityService.GestureResultCallback() {
                override fun onCompleted(gestureDescription: GestureDescription?) {
                    ok = true
                    latch.countDown()
                }

                override fun onCancelled(gestureDescription: GestureDescription?) {
                    latch.countDown()
                }
            },
            null,
        )
        if (!sent) return false
        latch.await(gesture.totalDurationMs() + 3000, TimeUnit.MILLISECONDS)
        return ok
    }

    private fun GestureDescription.totalDurationMs(): Long {
        var end = 0L
        for (i in 0 until strokeCount) {
            val s = getStroke(i)
            end = max(end, s.startTime + s.duration)
        }
        return end
    }
}
