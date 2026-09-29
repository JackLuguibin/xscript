package com.xscript.app.script

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.Context
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.RectF
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.text.InputType
import android.util.TypedValue
import android.view.ContextThemeWrapper
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.Toast
import com.xscript.app.XscriptApp
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin

/**
 * Script-facing UI: toast, blocking dialogs, overlay WebView windows and a drawing canvas.
 * Lives in the Python host process. Python polls window events through [poll] instead of
 * receiving Java→Python callbacks, which keeps threading on the Python side simple.
 */
object ScriptUi {
    private val main = Handler(Looper.getMainLooper())
    private val windows = ConcurrentHashMap<String, WebWin>()
    private val queues = ConcurrentHashMap<String, LinkedBlockingQueue<JSONObject>>()
    private var canvas: CanvasWin? = null

    private val ctx: Context get() = XscriptApp.instance

    fun call(op: String, json: String): String {
        val a = if (json.isBlank()) JSONObject() else JSONObject(json)
        return when (op) {
            "can_overlay" -> canOverlay().toString()
            "toast" -> toast(a)
            "alert" -> dialog("alert", a)
            "confirm" -> dialog("confirm", a)
            "prompt" -> dialog("prompt", a)
            "select" -> dialog("select", a)
            "win_create" -> winCreate(a)
            "win_show" -> onMain { windows[a.getString("id")]?.show(); "ok" }
            "win_close" -> winClose(a.getString("id"))
            "win_js" -> onMain { windows[a.getString("id")]?.js(a.getString("js"), a.optString("token")); "ok" }
            "win_update" -> onMain { windows[a.getString("id")]?.update(a); "ok" }
            "win_nav" -> onMain { windows[a.getString("id")]?.nav(a.getString("dir")).toString() }
            "canvas_show" -> onMain { ensureCanvas(); "ok" }
            "canvas_draw" -> onMain { ensureCanvas()?.add(a); "ok" }
            "canvas_remove" -> onMain { canvas?.remove(a.optString("item")); "ok" }
            "canvas_clear" -> onMain { canvas?.clear(); "ok" }
            "canvas_close" -> onMain { canvas?.close(); canvas = null; "ok" }
            "image_show" -> imageShow(a)
            else -> throw IllegalArgumentException("unknown ui op $op")
        }
    }

    /** Next event for a window as JSON, or "" on timeout. `{"key":..,"value":..}` */
    fun poll(id: String, timeoutMs: Long): String {
        val q = queues.getOrPut(id) { LinkedBlockingQueue() }
        val ev = q.poll(timeoutMs.coerceAtLeast(0), TimeUnit.MILLISECONDS) ?: return ""
        return ev.toString()
    }

    private fun emit(id: String, key: String, value: String?) {
        queues.getOrPut(id) { LinkedBlockingQueue() }
            .offer(JSONObject().put("key", key).put("value", value ?: JSONObject.NULL))
    }

    fun canOverlay(): Boolean = Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(ctx)

    private fun <T> onMain(block: () -> T): T {
        if (Looper.myLooper() == Looper.getMainLooper()) return block()
        val ref = AtomicReference<Any?>()
        val latch = CountDownLatch(1)
        main.post {
            try {
                ref.set(block())
            } catch (t: Throwable) {
                ref.set(t)
            } finally {
                latch.countDown()
            }
        }
        latch.await(10, TimeUnit.SECONDS)
        val v = ref.get()
        if (v is Throwable) throw v
        @Suppress("UNCHECKED_CAST")
        return v as T
    }

    private fun overlayType(): Int =
        if (Build.VERSION.SDK_INT >= 26) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_PHONE
        }

    private fun wm(): WindowManager = ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager

    private fun dp(v: Float): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, ctx.resources.displayMetrics).toInt()

    // ---------------------------------------------------------------- toast

    private fun toast(a: JSONObject): String {
        val msg = a.optString("msg")
        val long = a.optInt("dur", 2000) > 2500
        main.post { Toast.makeText(ctx, msg, if (long) Toast.LENGTH_LONG else Toast.LENGTH_SHORT).show() }
        return "ok"
    }

    // ---------------------------------------------------------------- dialogs

    /**
     * Blocks the calling (Python) thread until the user answers.
     * Returns {"ok": true|false, "value": ...}; ok=false means cancelled or no overlay permission.
     */
    private fun dialog(kind: String, a: JSONObject): String {
        if (!canOverlay()) {
            return JSONObject().put("ok", false).put("error", "overlay_permission").toString()
        }
        val result = AtomicReference(JSONObject().put("ok", false))
        val latch = CountDownLatch(1)
        main.post {
            try {
                val themed = ContextThemeWrapper(ctx, android.R.style.Theme_DeviceDefault_Light_Dialog_Alert)
                val b = AlertDialog.Builder(themed)
                a.optString("title").takeIf { it.isNotEmpty() }?.let { b.setTitle(it) }
                val submit = a.optString("submit", "确认")
                val cancel = a.optString("cancel", "取消")
                var input: EditText? = null
                when (kind) {
                    "alert" -> {
                        b.setMessage(a.optString("msg"))
                        b.setPositiveButton(submit) { _, _ -> result.set(JSONObject().put("ok", true)) }
                    }
                    "confirm" -> {
                        b.setMessage(a.optString("msg"))
                        b.setPositiveButton(submit) { _, _ -> result.set(JSONObject().put("ok", true).put("value", true)) }
                        b.setNegativeButton(cancel) { _, _ -> result.set(JSONObject().put("ok", true).put("value", false)) }
                    }
                    "prompt" -> {
                        b.setMessage(a.optString("msg"))
                        val et = EditText(themed).apply {
                            setText(a.optString("value"))
                            hint = a.optString("hint")
                            inputType = InputType.TYPE_CLASS_TEXT
                        }
                        input = et
                        val pad = dp(20f)
                        val box = FrameLayout(themed).apply {
                            setPadding(pad, dp(8f), pad, 0)
                            addView(et)
                        }
                        b.setView(box)
                        b.setPositiveButton(submit) { _, _ ->
                            result.set(JSONObject().put("ok", true).put("value", input?.text?.toString().orEmpty()))
                        }
                        b.setNegativeButton(cancel, null)
                    }
                    "select" -> {
                        val arr = a.optJSONArray("items") ?: JSONArray()
                        val items = Array(arr.length()) { arr.optString(it) }
                        if (a.optString("msg").isNotEmpty() && a.optString("title").isEmpty()) b.setTitle(a.optString("msg"))
                        b.setItems(items) { _, which -> result.set(JSONObject().put("ok", true).put("value", which)) }
                        b.setNegativeButton(cancel, null)
                    }
                }
                val d = b.create()
                d.setOnDismissListener { latch.countDown() }
                d.window?.setType(overlayType())
                d.show()
            } catch (t: Throwable) {
                result.set(JSONObject().put("ok", false).put("error", t.message ?: t.toString()))
                latch.countDown()
            }
        }
        latch.await()
        return result.get().toString()
    }

    // ---------------------------------------------------------------- web windows

    private fun winCreate(a: JSONObject): String {
        if (!canOverlay()) throw IllegalStateException("overlay permission not granted (悬浮窗权限)")
        val id = a.optString("id").ifEmpty { "w" + SystemClock.uptimeMillis() }
        queues.getOrPut(id) { LinkedBlockingQueue() }
        onMain {
            windows.remove(id)?.close()
            windows[id] = WebWin(id, a)
        }
        return id
    }

    private fun winClose(id: String): String {
        onMain { windows.remove(id)?.close() }
        emit(id, "__close", null)
        return "ok"
    }

    private fun parseSize(v: Any?, total: Int, fallback: Int): Int {
        val m = ctx.resources.displayMetrics
        return when (v) {
            null, JSONObject.NULL -> fallback
            is Number -> if (v.toInt() <= 0) fallback else v.toInt()
            is String -> {
                val s = v.trim().lowercase()
                when {
                    s.isEmpty() -> fallback
                    s == "match" || s == "match_parent" || s == "-1" -> total
                    s == "wrap" || s == "wrap_content" || s == "-2" -> ViewGroup.LayoutParams.WRAP_CONTENT
                    s.endsWith("vw") -> (m.widthPixels * (s.removeSuffix("vw").toFloatOrNull() ?: 100f) / 100f).toInt()
                    s.endsWith("vh") -> (m.heightPixels * (s.removeSuffix("vh").toFloatOrNull() ?: 100f) / 100f).toInt()
                    s.endsWith("%") -> (total * (s.removeSuffix("%").toFloatOrNull() ?: 100f) / 100f).toInt()
                    s.endsWith("dp") -> dp(s.removeSuffix("dp").toFloatOrNull() ?: 0f)
                    s.endsWith("px") -> s.removeSuffix("px").toFloatOrNull()?.toInt() ?: fallback
                    else -> s.toFloatOrNull()?.toInt() ?: fallback
                }
            }
            else -> fallback
        }
    }

    private fun parseColor(s: String?, fallback: Int): Int {
        if (s.isNullOrBlank()) return fallback
        val t = s.trim()
        Regex("""rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)""").matchEntire(t)?.let {
            val (r, g, b) = it.destructured
            val alpha = it.groupValues[4].toFloatOrNull()?.let { f -> if (f <= 1f) (f * 255).toInt() else f.toInt() } ?: 255
            return Color.argb(alpha, r.toInt(), g.toInt(), b.toInt())
        }
        return try {
            Color.parseColor(t)
        } catch (_: Exception) {
            fallback
        }
    }

    private class WebWin(val id: String, a: JSONObject) {
        val lp = WindowManager.LayoutParams()
        val root: DragFrame
        val web: WebView
        var shown = false

        init {
            val m = ctx.resources.displayMetrics
            lp.type = overlayType()
            lp.format = PixelFormat.TRANSLUCENT
            lp.flags = WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED
            web = WebView(ctx)
            root = DragFrame(ctx)
            root.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            configureWeb()
            lp.width = parseSize(a.opt("width"), m.widthPixels, (m.widthPixels * 0.9).toInt())
            lp.height = parseSize(a.opt("height"), m.heightPixels, (m.heightPixels * 0.6).toInt())
            update(a)
            load(a.optString("html"))
        }

        @SuppressLint("SetJavaScriptEnabled")
        private fun configureWeb() {
            val s = web.settings
            s.javaScriptEnabled = true
            s.domStorageEnabled = true
            s.allowFileAccess = true
            @Suppress("DEPRECATION")
            s.allowFileAccessFromFileURLs = true
            @Suppress("DEPRECATION")
            s.allowUniversalAccessFromFileURLs = true
            s.mediaPlaybackRequiresUserGesture = false
            web.setBackgroundColor(Color.TRANSPARENT)
            web.webChromeClient = WebChromeClient()
            web.webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView?, url: String?) {
                    emit(id, "__loaded", url)
                }
            }
            val bridge = JsBridge(id)
            // AScript pages call window.airscript.call(key, value)
            web.addJavascriptInterface(bridge, "airscript")
            web.addJavascriptInterface(bridge, "xscript")
        }

        fun load(html: String) {
            val src = html.trim()
            when {
                src.startsWith("http://") || src.startsWith("https://") || src.startsWith("file://") -> web.loadUrl(src)
                src.startsWith("/") && !src.contains('\n') && File(src).isFile -> web.loadUrl("file://$src")
                else -> web.loadDataWithBaseURL("file:///android_asset/", src, "text/html", "utf-8", null)
            }
        }

        fun update(a: JSONObject) {
            val m = ctx.resources.displayMetrics
            if (a.has("width")) lp.width = parseSize(a.opt("width"), m.widthPixels, lp.width)
            if (a.has("height")) lp.height = parseSize(a.opt("height"), m.heightPixels, lp.height)
            lp.gravity = if (a.has("gravity")) a.optInt("gravity") else (lp.gravity.takeIf { it != 0 } ?: Gravity.CENTER)
            if (a.has("x")) lp.x = a.optInt("x")
            if (a.has("y")) lp.y = a.optInt("y")
            if (a.has("dim")) {
                val dim = a.optDouble("dim", 0.0).toFloat()
                if (dim > 0f) {
                    lp.flags = lp.flags or WindowManager.LayoutParams.FLAG_DIM_BEHIND
                    lp.dimAmount = dim.coerceAtMost(1f)
                } else {
                    lp.flags = lp.flags and WindowManager.LayoutParams.FLAG_DIM_BEHIND.inv()
                }
            }
            if (a.has("focusable")) {
                lp.flags = if (a.optBoolean("focusable")) {
                    lp.flags and WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE.inv()
                } else {
                    lp.flags or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                }
            }
            if (a.optBoolean("fullscreen")) {
                lp.width = WindowManager.LayoutParams.MATCH_PARENT
                lp.height = WindowManager.LayoutParams.MATCH_PARENT
                lp.gravity = Gravity.TOP or Gravity.START
                lp.x = 0
                lp.y = 0
                lp.flags = lp.flags or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                    WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                if (Build.VERSION.SDK_INT >= 28) {
                    lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
                }
            }
            if (a.has("background")) root.setBackgroundColor(parseColor(a.optString("background"), Color.TRANSPARENT))
            if (a.has("drag")) root.draggable = a.optBoolean("drag")
            if (shown) wm().updateViewLayout(root, lp)
        }

        fun show() {
            if (shown) return
            wm().addView(root, lp)
            shown = true
        }

        fun js(code: String, token: String) {
            web.evaluateJavascript(code) { value ->
                if (token.isNotEmpty()) emit(id, "__js:$token", value)
            }
        }

        fun nav(dir: String): Boolean = when (dir) {
            "back" -> web.canGoBack().also { if (it) web.goBack() }
            "forward" -> web.canGoForward().also { if (it) web.goForward() }
            else -> false
        }

        fun close() {
            try {
                if (shown) wm().removeView(root)
            } catch (_: Exception) {
            }
            shown = false
            web.destroy()
        }

        inner class DragFrame(c: Context) : FrameLayout(c) {
            var draggable = false
            private val slop = ViewConfiguration.get(c).scaledTouchSlop
            private var downX = 0f
            private var downY = 0f
            private var startX = 0
            private var startY = 0
            private var dragging = false

            override fun onInterceptTouchEvent(ev: MotionEvent): Boolean {
                if (!draggable) return false
                when (ev.actionMasked) {
                    MotionEvent.ACTION_DOWN -> {
                        downX = ev.rawX
                        downY = ev.rawY
                        startX = lp.x
                        startY = lp.y
                        dragging = false
                    }
                    MotionEvent.ACTION_MOVE -> {
                        if (abs(ev.rawX - downX) > slop * 2 || abs(ev.rawY - downY) > slop * 2) dragging = true
                    }
                }
                return dragging
            }

            @SuppressLint("ClickableViewAccessibility")
            override fun onTouchEvent(ev: MotionEvent): Boolean {
                if (!dragging) return super.onTouchEvent(ev)
                when (ev.actionMasked) {
                    MotionEvent.ACTION_MOVE -> {
                        // Gravity-relative offsets: RIGHT/BOTTOM gravities invert the axis.
                        val sx = if (lp.gravity and Gravity.HORIZONTAL_GRAVITY_MASK == Gravity.RIGHT) -1 else 1
                        val sy = if (lp.gravity and Gravity.VERTICAL_GRAVITY_MASK == Gravity.BOTTOM) -1 else 1
                        lp.x = startX + sx * (ev.rawX - downX).toInt()
                        lp.y = startY + sy * (ev.rawY - downY).toInt()
                        if (shown) wm().updateViewLayout(this, lp)
                    }
                    MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> dragging = false
                }
                return true
            }
        }
    }

    class JsBridge(private val id: String) {
        @JavascriptInterface
        fun call(key: String?, value: String?) {
            ScriptUi.emit(id, key ?: "", value)
        }

        @JavascriptInterface
        fun call(key: String?) {
            ScriptUi.emit(id, key ?: "", null)
        }

        @JavascriptInterface
        fun close() {
            Handler(Looper.getMainLooper()).post { ScriptUi.windows.remove(id)?.close() }
            ScriptUi.emit(id, "__close", null)
        }
    }

    // ---------------------------------------------------------------- canvas

    private fun ensureCanvas(): CanvasWin? {
        if (!canOverlay()) return null
        canvas?.let { return it }
        return CanvasWin().also { canvas = it }
    }

    private class Item(val obj: JSONObject, val expiresAt: Long)

    private class CanvasWin {
        private val items = LinkedHashMap<String, Item>()
        private var seq = 0
        private val view = object : View(ctx) {
            private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
            private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
            private val text = Paint(Paint.ANTI_ALIAS_FLAG)
            private val loc = IntArray(2)

            override fun onDraw(c: Canvas) {
                val now = SystemClock.uptimeMillis()
                items.entries.removeAll { it.value.expiresAt in 1..now }
                getLocationOnScreen(loc)
                c.save()
                c.translate(-loc[0].toFloat(), -loc[1].toFloat())
                for (item in items.values) drawItem(c, item.obj)
                c.restore()
                val next = items.values.filter { it.expiresAt > 0 }.minOfOrNull { it.expiresAt }
                if (next != null) postInvalidateDelayed((next - now).coerceAtLeast(16))
            }

            private fun drawItem(c: Canvas, o: JSONObject) {
                val color = parseColor(o.optString("color"), Color.MAGENTA)
                stroke.color = color
                stroke.strokeWidth = o.optDouble("stroke_width", 2.0).toFloat()
                text.color = color
                text.textSize = dp(o.optDouble("font_size", 12.0).toFloat()) * 1f
                fun f(k: String) = o.optDouble(k, 0.0).toFloat()
                when (o.optString("shape")) {
                    "rect" -> {
                        c.drawRect(f("x1"), f("y1"), f("x2"), f("y2"), stroke)
                        label(c, o, f("x1"), f("y1"))
                    }
                    "region" -> {
                        fill.color = parseColor(o.optString("fill"), Color.argb(38, 255, 0, 255))
                        c.drawRect(f("x1"), f("y1"), f("x2"), f("y2"), fill)
                        c.drawRect(f("x1"), f("y1"), f("x2"), f("y2"), stroke)
                        label(c, o, f("x1"), f("y1"))
                    }
                    "circle" -> {
                        c.drawCircle(f("x"), f("y"), f("radius"), stroke)
                        label(c, o, f("x") - f("radius"), f("y") - f("radius"))
                    }
                    "oval" -> c.drawOval(RectF(f("x1"), f("y1"), f("x2"), f("y2")), stroke)
                    "line" -> c.drawLine(f("x1"), f("y1"), f("x2"), f("y2"), stroke)
                    "point" -> {
                        fill.color = color
                        c.drawCircle(f("x"), f("y"), o.optDouble("radius", 5.0).toFloat(), fill)
                    }
                    "text" -> c.drawText(o.optString("text"), f("x"), f("y"), text)
                    "cross" -> {
                        val s = o.optDouble("size", 30.0).toFloat() / 2
                        c.drawLine(f("x") - s, f("y"), f("x") + s, f("y"), stroke)
                        c.drawLine(f("x"), f("y") - s, f("x"), f("y") + s, stroke)
                        label(c, o, f("x") + s, f("y") - s)
                    }
                    "arrow" -> {
                        val x1 = f("x1"); val y1 = f("y1"); val x2 = f("x2"); val y2 = f("y2")
                        c.drawLine(x1, y1, x2, y2, stroke)
                        val ang = atan2((y2 - y1).toDouble(), (x2 - x1).toDouble())
                        val head = 18.0
                        for (d in listOf(Math.PI * 5 / 6, -Math.PI * 5 / 6)) {
                            c.drawLine(x2, y2, (x2 + head * cos(ang + d)).toFloat(), (y2 + head * sin(ang + d)).toFloat(), stroke)
                        }
                    }
                    "polygon" -> {
                        val pts = o.optJSONArray("points") ?: return
                        if (pts.length() < 2) return
                        val path = android.graphics.Path()
                        for (i in 0 until pts.length()) {
                            val p = pts.getJSONArray(i)
                            val x = p.getDouble(0).toFloat(); val y = p.getDouble(1).toFloat()
                            if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
                        }
                        if (o.optBoolean("close", true)) path.close()
                        c.drawPath(path, stroke)
                    }
                }
            }

            private fun label(c: Canvas, o: JSONObject, x: Float, y: Float) {
                val l = o.optString("label")
                if (l.isNotEmpty()) c.drawText(l, x + 2, (y - 4).coerceAtLeast(text.textSize), text)
            }
        }

        init {
            val lp = WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT,
                WindowManager.LayoutParams.MATCH_PARENT,
                overlayType(),
                WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                    WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT,
            )
            lp.gravity = Gravity.TOP or Gravity.START
            if (Build.VERSION.SDK_INT >= 28) {
                lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
            // Android 12+ drops touches (including injected accessibility/`input` taps) that pass
            // through a NOT_TOUCHABLE overlay of another UID whose opacity exceeds 0.8
            // ("Untrusted touch due to occlusion"). Keep this fullscreen draw layer at <= 0.8.
            if (Build.VERSION.SDK_INT >= 31) {
                val im = ctx.getSystemService(Context.INPUT_SERVICE) as android.hardware.input.InputManager
                lp.alpha = minOf(0.8f, im.maximumObscuringOpacityForTouch)
            }
            wm().addView(view, lp)
        }

        fun add(o: JSONObject) {
            val id = o.optString("id").ifEmpty { "i" + (seq++) }
            val dur = o.optLong("duration", 3000L)
            items.remove(id)
            items[id] = Item(o, if (dur > 0) SystemClock.uptimeMillis() + dur else 0L)
            view.invalidate()
        }

        fun remove(id: String) {
            if (items.remove(id) != null) view.invalidate()
        }

        fun clear() {
            items.clear()
            view.invalidate()
        }

        fun close() {
            try {
                wm().removeView(view)
            } catch (_: Exception) {
            }
        }
    }

    // ---------------------------------------------------------------- image window

    private var imageView: View? = null

    private fun imageShow(a: JSONObject): String {
        if (!canOverlay()) throw IllegalStateException("overlay permission not granted (悬浮窗权限)")
        val path = a.optString("path")
        onMain {
            imageView?.let {
                try {
                    wm().removeView(it)
                } catch (_: Exception) {
                }
            }
            val bmp = BitmapFactory.decodeFile(path) ?: return@onMain "error"
            val m = ctx.resources.displayMetrics
            val iv = ImageView(ctx).apply {
                setImageBitmap(bmp)
                scaleType = ImageView.ScaleType.FIT_CENTER
                setBackgroundColor(Color.argb(200, 0, 0, 0))
                setOnClickListener { v ->
                    try {
                        wm().removeView(v)
                    } catch (_: Exception) {
                    }
                    imageView = null
                }
            }
            val lp = WindowManager.LayoutParams(
                (m.widthPixels * 0.8).toInt(),
                (m.heightPixels * 0.5).toInt(),
                overlayType(),
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
                PixelFormat.TRANSLUCENT,
            )
            lp.gravity = Gravity.CENTER
            wm().addView(iv, lp)
            imageView = iv
            "ok"
        }
        return "ok"
    }
}
