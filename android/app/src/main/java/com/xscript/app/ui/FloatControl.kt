package com.xscript.app.ui

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings as AndroidSettings
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowInsets
import android.view.WindowManager
import android.view.animation.DecelerateInterpolator
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import com.xscript.app.R
import com.xscript.app.events.EventHub
import com.xscript.app.runtime.RunState
import com.xscript.app.runtime.ScriptService
import com.xscript.app.settings.Settings
import org.json.JSONObject
import kotlin.math.abs

/**
 * Floating window (悬浮窗), main process. It shows the run state, project name and elapsed time as a
 * small pill that docks to a screen edge; after a few idle seconds it shrinks to a dimmed 48dp ball;
 * tapping opens a panel with 运行/停止, 日志, 打开, 隐藏 and the buttons a script added with
 * `FloatWindow.add_menu`.
 *
 * Visibility is decided by [FloatLogic.decide]: it appears when the app goes to the background while a
 * script runs (or always, with the setting "后台一直显示"), and hides again when one of our activities is
 * on screen or the script ends (an error keeps it up for a few seconds). No overlay grant = no window and
 * no error. The window lives in the main process, which the DeviceHttpService foreground notification keeps
 * alive; [restore] re-creates it after that process was restarted. It stays out of the status bar, camera
 * cut-out and navigation / gesture bar, and is placed again after rotation.
 */
object FloatControl {
    private val main = Handler(Looper.getMainLooper())

    private class MenuItem(val id: String, val icon: String)

    // ---- state (main thread; the @Volatile ones are also read by /status on the HTTP thread) ----
    private var root: FrameLayout? = null
    private var box: LinearLayout? = null
    private var head: LinearLayout? = null
    private var panel: LinearLayout? = null
    private var sysRow: LinearLayout? = null
    private var menuRow: LinearLayout? = null
    private var ball: TextView? = null
    private var dot: View? = null
    private var title: TextView? = null
    private var timer: TextView? = null
    private var toggleIcon: ImageView? = null
    private var toggleLabel: TextView? = null
    private var toggleBox: View? = null
    private var lp = WindowManager.LayoutParams()
    private var state = FloatLogic.State()
    private var startedActivities = 0
    private var screenW = 0
    private var screenH = 0
    private var insets = FloatLogic.Insets.NONE
    private var dragging = false
    private var touching = false
    private var animator: ValueAnimator? = null
    private var scriptForce: Boolean? = null
    private var userHidden = false
    private var observedSince = 0L
    private var idleConfirmed = false
    private var scriptX: Float? = null
    private var scriptY: Float? = null
    private var scriptDim = 1f
    private var removeSystem = false
    private val menus = LinkedHashMap<String, MenuItem>()
    private var menuKey = ""
    private var lastName = ""
    private var noticeUntil = 0L
    private var lastAliveCheck = 0L
    private var aliveOk = false
    private var builtConfig = ""
    private var lastCd = ""

    @Volatile private var foreground = false
    @Volatile private var lastReason: FloatLogic.Reason? = FloatLogic.Reason.IDLE
    @Volatile private var bounds = Rect()
    @Volatile private var dockRight = FloatLogic.DEFAULT_DOCK.right
    @Volatile private var visibleNow = false
    @Volatile private var modeNow = FloatLogic.Mode.PILL
    @Volatile private var alphaNow = 1f
    @Volatile private var errorNow = false
    @Volatile private var menuCount = 0
    @Volatile private var insetsNow = FloatLogic.Insets.NONE
    @Volatile private var appCtx: Context? = null

    private const val TITLE = "XScriptFloat"
    private const val TICK_MS = 1000L
    private const val ALIVE_MS = 4000L
    private const val NOTICE_MS = 8000L

    fun canShow(context: Context): Boolean = Build.VERSION.SDK_INT < 23 || AndroidSettings.canDrawOverlays(context)

    /** Track whether one of our activities is on screen (main process only). Call once from Application.onCreate. */
    fun install(app: Application) {
        appCtx = app.applicationContext
        app.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
            override fun onActivityStarted(activity: Activity) {
                startedActivities++
                foreground = true
                // Coming back to the app ends "隐藏".
                userHidden = false
                sync(app)
            }

            override fun onActivityStopped(activity: Activity) {
                startedActivities = maxOf(0, startedActivities - 1)
                foreground = startedActivities > 0
                sync(app)
            }

            override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
            override fun onActivityResumed(activity: Activity) {}
            override fun onActivityPaused(activity: Activity) {}
            override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
            override fun onActivityDestroyed(activity: Activity) {}
        })
    }

    /** After the main process (re)started: bring the window back when a script is still running. Delayed so a cold start from the launcher does not flash it. */
    fun restore(context: Context) {
        main.postDelayed({ sync(context) }, 1500)
    }

    /** Re-evaluate visibility; safe to call from any thread. */
    fun sync(context: Context) {
        val ctx = context.applicationContext
        appCtx = ctx
        main.post { syncOnMain(ctx, true) }
    }

    /** A run started: a new run brings the window back after 隐藏 and clears the last error. */
    fun scriptStarted(context: Context) {
        main.post {
            userHidden = false
            noticeUntil = 0
            aliveOk = true
            lastAliveCheck = System.currentTimeMillis()
        }
        sync(context)
    }

    /** `ui.float_show(x, y, dim)` from a script: show for this run (still needs the overlay grant). [arg] is that call as JSON. */
    fun forceShow(context: Context, arg: String = "") {
        val a = try {
            if (arg.isBlank()) JSONObject() else JSONObject(arg)
        } catch (_: Exception) {
            JSONObject()
        }
        main.post {
            scriptForce = true
            scriptX = if (a.has("x")) a.optDouble("x").toFloat() else null
            scriptY = if (a.has("y")) a.optDouble("y").toFloat() else null
            scriptDim = a.optDouble("dim", 1.0).toFloat().coerceIn(0.1f, 1f)
            root?.let { r -> render(r.context.applicationContext) }
        }
        sync(context)
    }

    /** `ui.float_hide()` from a script: hide for this run. */
    fun forceHide(context: Context) {
        main.post { scriptForce = false }
        sync(context)
    }

    /** `FloatWindow.add_menu(id, icon, callback, remove_system)`: [arg] = {id, icon, remove_system}. */
    fun addMenu(context: Context, arg: String) {
        val a = JSONObject(arg)
        val id = a.getString("id")
        main.post {
            menus[id] = MenuItem(id, a.optString("icon"))
            if (a.optBoolean("remove_system", false)) removeSystem = true
            menuCount = menus.size
            root?.let { r -> render(r.context.applicationContext) }
        }
        sync(context)
    }

    /** The script ended (or its process died): forget `ui.float_*` overrides and custom buttons; an error keeps the window up for a moment. */
    fun scriptEnded(context: Context, exit: String? = null) {
        main.post {
            scriptForce = null
            scriptX = null
            scriptY = null
            scriptDim = 1f
            menus.clear()
            menuKey = ""
            menuCount = 0
            removeSystem = false
            if (exit != null && FloatLogic.isError(exit)) {
                noticeUntil = System.currentTimeMillis() + NOTICE_MS
                state = FloatLogic.next(state, FloatLogic.Event.WAKE)
                scheduleIdle()
            }
        }
        sync(context)
    }

    /** Intent for the system page where the user grants 悬浮窗权限 to this app. */
    fun permissionIntent(context: Context): Intent =
        Intent(AndroidSettings.ACTION_MANAGE_OVERLAY_PERMISSION, android.net.Uri.parse("package:${context.packageName}"))

    /** Value text for the "悬浮窗显示" settings row. */
    fun modeSummary(context: Context): String {
        val mode = Settings.floatMode
        return if (mode != "off" && !canShow(context)) "${Settings.floatModeLabel(mode)} · 需授权" else Settings.floatModeLabel(mode)
    }

    /** Dialog to pick 运行时显示 / 后台一直显示 / 已关闭; guides to the system permission page when the grant is missing. */
    fun chooseMode(activity: Activity, onChange: () -> Unit) {
        val modes = arrayOf("run", "always", "off")
        com.google.android.material.dialog.MaterialAlertDialogBuilder(activity)
            .setTitle("悬浮窗显示")
            .setSingleChoiceItems(modes.map { Settings.floatModeLabel(it) }.toTypedArray(), modes.indexOf(Settings.floatMode)) { d, which ->
                Settings.floatMode = modes[which]
                d.dismiss()
                sync(activity)
                onChange()
                if (modes[which] != "off" && !canShow(activity)) askPermission(activity)
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun askPermission(activity: Activity) {
        com.google.android.material.dialog.MaterialAlertDialogBuilder(activity)
            .setTitle("需要悬浮窗权限")
            .setMessage("应用切到后台后，悬浮窗才能显示运行状态。没有这个权限时悬浮窗不会出现，脚本运行不受影响。")
            .setPositiveButton("去开启") { _, _ ->
                try {
                    activity.startActivity(permissionIntent(activity))
                } catch (_: Exception) {
                }
            }
            .setNegativeButton("以后再说", null)
            .show()
    }

    /** Snapshot for `/status` → `overlay`. */
    fun status(context: Context): JSONObject {
        val b = bounds
        val i = insetsNow
        val o = JSONObject()
            .put("enabled", Settings.floatOnRun)
            .put("always", Settings.floatAlways)
            .put("mode", Settings.floatMode)
            .put("permitted", canShow(context))
            .put("visible", visibleNow)
            .put("state", if (visibleNow) modeNow.label else JSONObject.NULL)
            .put("expanded", visibleNow && modeNow == FloatLogic.Mode.PANEL)
            .put("app_foreground", foreground)
            .put("side", if (dockRight) "right" else "left")
            .put("reason", lastReason?.label ?: JSONObject.NULL)
            .put("error", errorNow)
            .put("menus", menuCount)
            .put("insets", JSONObject().put("left", i.left).put("top", i.top).put("right", i.right).put("bottom", i.bottom))
        if (visibleNow) {
            o.put("x", b.left).put("y", b.top).put("width", b.width()).put("height", b.height()).put("alpha", alphaNow.toDouble())
                .put("screen_width", screenW).put("screen_height", screenH)
        }
        return o
    }

    // ---- visibility ---------------------------------------------------------------------------

    /** Is a script running? The status file is read every time; the process list (an IPC) at most every [ALIVE_MS] unless [force]. */
    private fun runningNow(ctx: Context, force: Boolean): Boolean {
        val name = RunState.get(ctx) ?: return false
        val now = System.currentTimeMillis()
        if (force || now - lastAliveCheck >= ALIVE_MS) {
            aliveOk = RunState.scriptProcessAlive(ctx)
            lastAliveCheck = now
            if (!aliveOk) RunState.set(ctx, null)
        }
        if (aliveOk) lastName = name
        return aliveOk
    }

    private fun syncOnMain(ctx: Context, force: Boolean) {
        val running = runningNow(ctx, force)
        val notice = !running && System.currentTimeMillis() < noticeUntil
        errorNow = notice
        val d = FloatLogic.decide(
            canShow(ctx), Settings.floatOnRun, Settings.floatAlways, running, foreground, scriptForce, userHidden, notice,
        )
        lastReason = d.reason
        if (!d.show) {
            // A run that just ended (or a status file read mid-update) must not flicker the window: confirm "idle" once more first.
            if (d.reason == FloatLogic.Reason.IDLE && root != null && !idleConfirmed) {
                idleConfirmed = true
                main.postDelayed({ syncOnMain(ctx, true) }, 600)
                return
            }
            idleConfirmed = false
            removeView(ctx)
            return
        }
        idleConfirmed = false
        if (root == null && !addView(ctx)) {
            lastReason = FloatLogic.Reason.NO_PERMISSION
            return
        }
        val wasVisible = state.visible
        state = FloatLogic.next(state, FloatLogic.Event.SHOW)
        render(ctx)
        if (!wasVisible) scheduleIdle()
        main.removeCallbacks(tick)
        main.postDelayed(tick, TICK_MS)
    }

    private val tick = object : Runnable {
        override fun run() {
            val ctx = appCtx ?: return
            if (root == null) return
            // Screen off: nothing to look at, check again rarely.
            val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
            if (!pm.isInteractive) {
                main.postDelayed(this, 5000)
                return
            }
            if (configKey(ctx) != builtConfig) {
                // Dark mode or font size changed: rebuild with the new colours / sizes, keep the mode.
                val keep = state
                removeView(ctx)
                syncOnMain(ctx, true)
                if (root != null && keep.visible) {
                    state = keep
                    render(ctx)
                    scheduleIdle()
                }
                return
            }
            syncOnMain(ctx, false)
            if (root != null) {
                // The screen can rotate or resize while the window is up.
                val (w, h) = screenSize(ctx)
                if (w != screenW || h != screenH) {
                    screenW = w; screenH = h
                    insets = computeInsets(ctx)
                    insetsNow = insets
                    reposition(ctx)
                }
            }
        }
    }

    private val idleRun: Runnable = object : Runnable {
        override fun run() {
            val ctx = appCtx ?: return
            if (root == null || dragging || touching) return
            // An error flash stays a readable pill until it is over.
            val left = noticeUntil - System.currentTimeMillis()
            if (left > 0 && errorNow) {
                main.postDelayed(this, left + 50)
                return
            }
            state = FloatLogic.next(state, FloatLogic.Event.IDLE)
            render(ctx)
        }
    }

    private fun scheduleIdle() {
        main.removeCallbacks(idleRun)
        FloatLogic.idleMs(state.mode)?.let { main.postDelayed(idleRun, it) }
    }

    private fun removeView(ctx: Context) {
        main.removeCallbacks(tick)
        main.removeCallbacks(idleRun)
        animator?.cancel()
        val v = root
        if (v != null) {
            try {
                (ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager).removeView(v)
            } catch (_: Exception) {
            }
        }
        root = null; box = null; head = null; panel = null; sysRow = null; menuRow = null
        ball = null; dot = null; title = null; timer = null
        toggleIcon = null; toggleLabel = null; toggleBox = null
        menuKey = ""
        lastCd = ""
        state = FloatLogic.next(state, FloatLogic.Event.HIDE)
        visibleNow = false
        modeNow = FloatLogic.Mode.PILL
        bounds = Rect()
    }

    // ---- rendering ----------------------------------------------------------------------------

    private fun dp(ctx: Context, v: Float): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, ctx.resources.displayMetrics).toInt()

    private fun night(ctx: Context): Boolean =
        ctx.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES

    private fun configKey(ctx: Context): String =
        "${ctx.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK}/${ctx.resources.configuration.fontScale}"

    private fun screenSize(ctx: Context): Pair<Int, Int> {
        val wm = ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        if (Build.VERSION.SDK_INT >= 30) {
            val b = wm.maximumWindowMetrics.bounds
            return b.width() to b.height()
        }
        val m = android.util.DisplayMetrics()
        @Suppress("DEPRECATION")
        wm.defaultDisplay.getRealMetrics(m)
        return m.widthPixels to m.heightPixels
    }

    /** Status bar, camera cut-out and navigation / gesture bar: the window never covers them. */
    private fun computeInsets(ctx: Context): FloatLogic.Insets {
        val wm = ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        if (Build.VERSION.SDK_INT >= 30) {
            try {
                val i = wm.maximumWindowMetrics.windowInsets.getInsetsIgnoringVisibility(
                    WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout(),
                )
                return FloatLogic.Insets(i.left, i.top, i.right, i.bottom)
            } catch (_: Exception) {
            }
        }
        val res = ctx.resources
        fun size(name: String): Int {
            val id = res.getIdentifier(name, "dimen", "android")
            return if (id > 0) res.getDimensionPixelSize(id) else 0
        }
        val portrait = res.configuration.orientation == Configuration.ORIENTATION_PORTRAIT
        val navId = res.getIdentifier("config_showNavigationBar", "bool", "android")
        val hasNav = navId > 0 && res.getBoolean(navId)
        return FloatLogic.Insets(0, size("status_bar_height"), 0, if (portrait && hasNav) size("navigation_bar_height") else 0)
    }

    private fun stateColor(running: Boolean, error: Boolean): Int = when {
        error -> Color.parseColor("#FFFF5A52")
        running -> Color.parseColor("#FF34C759")
        else -> Color.parseColor("#FF9AA5B1")
    }

    /** Colours for light / dark mode: a light panel with dark icons in light mode, a dark one with light icons at night. */
    private class Palette(val bg: Int, val stroke: Int, val text: Int, val sub: Int, val ripple: Int, val play: Int, val stop: Int)

    private fun palette(ctx: Context): Palette = if (night(ctx)) {
        Palette(
            Color.argb(255, 34, 39, 46), Color.argb(110, 255, 255, 255), Color.parseColor("#FFEAEFF4"),
            Color.parseColor("#FFAEB9C4"), Color.argb(70, 255, 255, 255), Color.parseColor("#FF4CD27A"), Color.parseColor("#FFFF6B63"),
        )
    } else {
        Palette(
            Color.argb(255, 249, 250, 252), Color.argb(70, 0, 0, 0), Color.parseColor("#FF1B2430"),
            Color.parseColor("#FF5B6773"), Color.argb(46, 0, 0, 0), Color.parseColor("#FF1E9E4A"), Color.parseColor("#FFD93A32"),
        )
    }

    private fun panelBackground(ctx: Context, radiusDp: Float) = GradientDrawable().apply {
        val p = palette(ctx)
        cornerRadius = dp(ctx, radiusDp).toFloat()
        // The hairline keeps the window visible on a background of the same brightness.
        setColor(p.bg)
        setStroke(dp(ctx, 1f).coerceAtLeast(1), p.stroke)
    }

    private fun render(ctx: Context) {
        val r = root ?: return
        val running = runningNow(ctx, false)
        val name = if (running) RunState.get(ctx) else null
        val err = errorNow && !running
        modeNow = state.mode

        val color = stateColor(running, err)
        val titleText = when {
            running -> name ?: lastName
            err -> "${lastName.ifEmpty { "脚本" }} 出错"
            else -> "XScript 空闲"
        }
        var elapsed = 0L
        if (running) {
            val since = RunState.since(ctx) ?: observedSince.takeIf { it > 0 } ?: System.currentTimeMillis().also { observedSince = it }
            elapsed = System.currentTimeMillis() - since
        } else {
            observedSince = 0
        }
        val timeText = if (running) FloatLogic.formatElapsed(elapsed) else ""

        setText(title, titleText)
        setText(timer, timeText)
        timer?.visibility = if (running) View.VISIBLE else View.GONE
        (dot?.background as? GradientDrawable)?.setColor(color)
        ball?.let { b ->
            setText(b, when { running -> FloatLogic.formatBall(elapsed); err -> "!"; else -> "空闲" })
            (b.background as? GradientDrawable)?.setStroke(dp(ctx, 3f), color)
        }
        val pal = palette(ctx)
        toggleIcon?.let { i ->
            i.setImageResource(if (running) R.drawable.ic_sym_stop else R.drawable.ic_sym_play_arrow)
            i.setColorFilter(if (running) pal.stop else pal.play)
        }
        setText(toggleLabel, if (running) "停止" else "运行")
        toggleLabel?.setTextColor(if (running) pal.stop else pal.play)
        toggleBox?.contentDescription = if (running) "停止脚本" else "运行脚本"

        val inBall = state.mode == FloatLogic.Mode.BALL
        val showPanel = state.mode == FloatLogic.Mode.PANEL
        box?.visibility = if (inBall) View.GONE else View.VISIBLE
        ball?.visibility = if (inBall) View.VISIBLE else View.GONE
        val sysShown = showPanel && (!removeSystem || menus.isEmpty())
        sysRow?.visibility = if (sysShown) View.VISIBLE else View.GONE
        buildMenuRow(ctx)
        menuRow?.visibility = if (showPanel && menus.isNotEmpty()) View.VISIBLE else View.GONE
        panel?.visibility = if (showPanel) View.VISIBLE else View.GONE

        val stateWord = when { running -> "运行中"; err -> "出错"; else -> "空闲" }
        val cd = "XScript 悬浮窗，$stateWord，$titleText${if (running) "，已运行 $timeText" else ""}，点按${if (showPanel) "收起" else "展开"}"
        if (cd != lastCd) {
            lastCd = cd
            head?.contentDescription = cd
            ball?.contentDescription = cd
        }
        alphaNow = FloatLogic.alpha(state.mode, scriptDim, touching || dragging)
        if (r.alpha != alphaNow) r.alpha = alphaNow
        r.post { reposition(ctx) }
    }

    private fun setText(v: TextView?, t: String) {
        if (v != null && v.text.toString() != t) v.text = t
    }

    /** Rebuild the script's custom buttons when the set changed: rows of up to [PER_ROW]. */
    private fun buildMenuRow(ctx: Context) {
        val col = menuRow ?: return
        val key = menus.values.joinToString("|") { it.id + ":" + it.icon } + "/" + night(ctx)
        if (key == menuKey) return
        menuKey = key
        col.removeAllViews()
        val pal = palette(ctx)
        menus.values.chunked(PER_ROW).forEach { chunk ->
            val row = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER
            }
            for (m in chunk) {
                val bmp: Bitmap? = if (m.icon.isNotEmpty()) {
                    try {
                        BitmapFactory.decodeFile(m.icon)
                    } catch (_: Throwable) {
                        null
                    }
                } else {
                    null
                }
                // The script's own icon keeps its colours; the generic one follows light / dark.
                val b = iconButton(ctx, m.id, "悬浮窗按钮 ${m.id}", pal) { icon ->
                    if (bmp != null) {
                        icon.setImageBitmap(bmp)
                    } else {
                        icon.setImageResource(R.drawable.ic_sym_menu)
                        icon.setColorFilter(pal.text)
                    }
                }
                b.setOnClickListener {
                    EventHub.floatMenu(m.id)
                    action(ctx, collapse = false)
                }
                row.addView(b, LinearLayout.LayoutParams(WRAP, WRAP))
            }
            col.addView(row, LinearLayout.LayoutParams(WRAP, WRAP).apply { gravity = Gravity.CENTER_HORIZONTAL })
        }
    }

    private const val PER_ROW = 4

    /**
     * Measure the content ourselves and give the window that exact size: a WRAP_CONTENT overlay does not
     * reliably grow when its content gets wider (pill → panel with buttons), it would clip the buttons.
     */
    private fun fit(r: View): Pair<Int, Int> {
        val maxW = maxOf(1, screenW - insets.left - insets.right)
        val maxH = maxOf(1, screenH - insets.top - insets.bottom)
        r.measure(
            View.MeasureSpec.makeMeasureSpec(maxW, View.MeasureSpec.AT_MOST),
            View.MeasureSpec.makeMeasureSpec(maxH, View.MeasureSpec.AT_MOST),
        )
        return r.measuredWidth to r.measuredHeight
    }

    /** Put the window at its stored dock (unless the user is dragging it). */
    private fun reposition(ctx: Context) {
        val r = root ?: return
        if (dragging) return
        if (screenW == 0) {
            screenSize(ctx).let { screenW = it.first; screenH = it.second }
            insets = computeInsets(ctx)
            insetsNow = insets
        }
        val (w, h) = fit(r)
        if (w == 0 || h == 0) return
        val land = screenW > screenH
        val stored = Settings.floatDock(land)
        // ui.float_show(x, y) positions the window until the script ends or the user drags it.
        val dock = if (scriptX != null || scriptY != null) {
            FloatLogic.resolve(scriptX, scriptY, stored, w, h, screenW, screenH, insets)
        } else {
            stored
        }
        dockRight = dock.right
        val (x, y) = FloatLogic.place(dock, w, h, screenW, screenH, insets)
        moveTo(r, x, y, w, h)
    }

    private fun moveTo(r: View, x: Int, y: Int, w: Int = lp.width, h: Int = lp.height) {
        if (x != lp.x || y != lp.y || w != lp.width || h != lp.height || r.visibility != View.VISIBLE) {
            lp.x = x
            lp.y = y
            lp.width = w
            lp.height = h
            try {
                (r.context.getSystemService(Context.WINDOW_SERVICE) as WindowManager).updateViewLayout(r, lp)
            } catch (_: Exception) {
                return
            }
            r.visibility = View.VISIBLE
        }
        bounds = Rect(x, y, x + w, y + h)
        visibleNow = true
    }

    private fun rounded(ctx: Context, color: Int, radiusDp: Float) = GradientDrawable().apply {
        setColor(color)
        cornerRadius = dp(ctx, radiusDp).toFloat()
    }

    /**
     * Icon over a small label, at least 48dp in both directions (64 x 56dp by default), with a ripple. [setup] fills
     * the 24dp icon. Returns the clickable container; the icon and label are decoration for the screen reader.
     */
    private fun iconButton(
        ctx: Context, text: String, desc: String, pal: Palette,
        setup: (ImageView) -> Unit,
    ): LinearLayout = iconButtonParts(ctx, text, desc, pal, setup).first

    private fun iconButtonParts(
        ctx: Context, text: String, desc: String, pal: Palette, setup: (ImageView) -> Unit,
    ): Triple<LinearLayout, ImageView, TextView> {
        val icon = ImageView(ctx).apply {
            scaleType = ImageView.ScaleType.FIT_CENTER
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            setup(this)
        }
        val label = TextView(ctx).apply {
            this.text = text
            textSize = 11f
            setTextColor(pal.text)
            gravity = Gravity.CENTER
            isSingleLine = true
            ellipsize = android.text.TextUtils.TruncateAt.END
            maxWidth = dp(ctx, 72f)
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }
        val box = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            minimumWidth = dp(ctx, 64f)
            minimumHeight = dp(ctx, 56f)
            setPadding(dp(ctx, 4f), dp(ctx, 6f), dp(ctx, 4f), dp(ctx, 5f))
            contentDescription = desc
            isClickable = true
            background = android.graphics.drawable.RippleDrawable(
                android.content.res.ColorStateList.valueOf(pal.ripple), null, rounded(ctx, Color.BLACK, 14f),
            )
            addView(icon, LinearLayout.LayoutParams(dp(ctx, 24f), dp(ctx, 24f)).apply { gravity = Gravity.CENTER_HORIZONTAL })
            addView(label, LinearLayout.LayoutParams(WRAP, WRAP).apply { topMargin = dp(ctx, 3f); gravity = Gravity.CENTER_HORIZONTAL })
        }
        return Triple(box, icon, label)
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun addView(ctx: Context): Boolean {
        if (!canShow(ctx)) return false
        val wm = ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        screenSize(ctx).let { screenW = it.first; screenH = it.second }
        insets = computeInsets(ctx)
        insetsNow = insets
        builtConfig = configKey(ctx)
        val pal = palette(ctx)

        val frame = FrameLayout(ctx).apply {
            // Hidden until [reposition] has docked it, so it never flashes at the top-left corner.
            visibility = View.INVISIBLE
        }
        val b = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            val p = dp(ctx, 4f)
            setPadding(p, p, p, p)
            background = panelBackground(ctx, 24f)
        }
        val hd = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            minimumHeight = dp(ctx, 48f)
            setPadding(dp(ctx, 12f), 0, dp(ctx, 14f), 0)
            isClickable = true
        }
        val d = View(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(dp(ctx, 10f), dp(ctx, 10f)).apply { rightMargin = dp(ctx, 8f) }
            background = GradientDrawable().apply { shape = GradientDrawable.OVAL }
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }
        val t = TextView(ctx).apply {
            setTextColor(pal.text)
            textSize = 14f
            maxWidth = dp(ctx, 140f)
            isSingleLine = true
            ellipsize = android.text.TextUtils.TruncateAt.END
        }
        val tm = TextView(ctx).apply {
            setTextColor(pal.sub)
            textSize = 13f
            typeface = android.graphics.Typeface.MONOSPACE
            setPadding(dp(ctx, 8f), 0, 0, 0)
        }
        hd.addView(d)
        hd.addView(t)
        hd.addView(tm)

        val (tgBox, tgIcon, tgLabel) = iconButtonParts(ctx, "运行", "运行脚本", pal) { it.setImageResource(R.drawable.ic_sym_play_arrow) }
        tgBox.setOnClickListener {
            if (RunState.current(ctx) != null) {
                ScriptService.stop(ctx)
                RunState.set(ctx, null)
            } else {
                val last = Settings.lastProject
                if (last.isNotEmpty() && com.xscript.app.project.ProjectStore(ctx).exists(last)) {
                    ScriptService.run(ctx, last)
                } else {
                    startApp(ctx, ProjectsActivity::class.java)
                }
            }
            action(ctx)
        }
        val logs = iconButton(ctx, "日志", "查看日志", pal) { it.setImageResource(R.drawable.ic_sym_article); it.setColorFilter(pal.text) }
        logs.setOnClickListener {
            startApp(ctx, LogActivity::class.java)
            action(ctx)
        }
        val open = iconButton(ctx, "打开", "打开应用", pal) { it.setImageResource(R.drawable.ic_sym_open_in_new); it.setColorFilter(pal.text) }
        open.setOnClickListener {
            startApp(ctx, com.xscript.app.LauncherActivity.home(ctx))
            action(ctx)
        }
        val hide = iconButton(ctx, "隐藏", "隐藏悬浮窗，下次运行或打开应用后再出现", pal) { it.setImageResource(R.drawable.ic_sym_visibility_off); it.setColorFilter(pal.text) }
        hide.setOnClickListener {
            userHidden = true
            syncOnMain(ctx, false)
        }
        val sys = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
        }
        for (v in listOf(tgBox, logs, open, hide)) sys.addView(v, LinearLayout.LayoutParams(WRAP, WRAP))
        val menu = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
        }
        val pnl = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(ctx, 4f), 0, dp(ctx, 4f), dp(ctx, 2f))
            addView(sys, LinearLayout.LayoutParams(WRAP, WRAP).apply { gravity = Gravity.CENTER_HORIZONTAL })
            addView(menu, LinearLayout.LayoutParams(WRAP, WRAP).apply { gravity = Gravity.CENTER_HORIZONTAL })
        }
        // Explicit WRAP_CONTENT everywhere: a vertical LinearLayout's default MATCH_PARENT children get squeezed to the
        // narrowest sibling when the window wraps its content (the panel buttons were cut off next to a short title).
        val centered = LinearLayout.LayoutParams(WRAP, WRAP).apply { gravity = Gravity.CENTER_HORIZONTAL }
        b.addView(hd, LinearLayout.LayoutParams(WRAP, WRAP).apply { gravity = Gravity.CENTER_HORIZONTAL })
        b.addView(pnl, LinearLayout.LayoutParams(centered))

        val ballView = TextView(ctx).apply {
            gravity = Gravity.CENTER
            setTextColor(pal.text)
            textSize = 11f
            typeface = android.graphics.Typeface.create(android.graphics.Typeface.MONOSPACE, android.graphics.Typeface.BOLD)
            isSingleLine = true
            val size = dp(ctx, 48f)
            layoutParams = FrameLayout.LayoutParams(size, size)
            background = panelBackground(ctx, 24f).also { it.cornerRadius = dp(ctx, 24f).toFloat() }
            isClickable = true
            visibility = View.GONE
        }
        frame.addView(b)
        frame.addView(ballView)

        val newLp = WindowManager.LayoutParams().apply {
            width = WindowManager.LayoutParams.WRAP_CONTENT
            height = WindowManager.LayoutParams.WRAP_CONTENT
            type = if (Build.VERSION.SDK_INT >= 26) {
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            } else {
                @Suppress("DEPRECATION")
                WindowManager.LayoutParams.TYPE_PHONE
            }
            flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
            format = PixelFormat.TRANSLUCENT
            gravity = Gravity.TOP or Gravity.START
            setTitle(TITLE)
            x = 0
            y = 0
        }
        lp = newLp

        val slop = maxOf(ViewConfiguration.get(ctx).scaledTouchSlop, dp(ctx, 6f))
        val touch = dragListener(ctx, frame, wm, slop)
        hd.setOnTouchListener(touch)
        ballView.setOnTouchListener(touch)
        hd.setOnClickListener { onTap(ctx) }
        ballView.setOnClickListener { onTap(ctx) }
        // Content width changes (timer digits, panel, ball): keep a right-docked window flush with its edge.
        frame.addOnLayoutChangeListener { v, l, t0, r, b0, ol, ot, oldR, oldB ->
            if (!dragging && ((r - l) != (oldR - ol) || (b0 - t0) != (oldB - ot))) v.post { reposition(ctx) }
        }

        return try {
            wm.addView(frame, lp)
            root = frame; box = b; head = hd; panel = pnl; sysRow = sys; menuRow = menu
            ball = ballView; dot = d; title = t; timer = tm
            toggleIcon = tgIcon; toggleLabel = tgLabel; toggleBox = tgBox
            true
        } catch (_: Exception) {
            // Overlay grant revoked meanwhile, or no window token: stay silent.
            false
        }
    }

    private const val WRAP = LinearLayout.LayoutParams.WRAP_CONTENT

    @SuppressLint("ClickableViewAccessibility")
    private fun dragListener(ctx: Context, frame: FrameLayout, wm: WindowManager, slop: Int): View.OnTouchListener {
        var downX = 0f
        var downY = 0f
        var startX = 0
        var startY = 0
        var moved = false
        return View.OnTouchListener { v, ev ->
            when (ev.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    animator?.cancel()
                    main.removeCallbacks(idleRun)
                    touching = true
                    downX = ev.rawX; downY = ev.rawY; startX = lp.x; startY = lp.y; moved = false
                    frame.alpha = FloatLogic.alpha(state.mode, scriptDim, true)
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = ev.rawX - downX
                    val dy = ev.rawY - downY
                    if (moved || abs(dx) > slop || abs(dy) > slop) {
                        moved = true
                        dragging = true
                        val w = lp.width
                        val h = lp.height
                        lp.x = FloatLogic.clampX(startX + dx.toInt(), w, screenW, insets)
                        lp.y = FloatLogic.clampY(startY + dy.toInt(), h, screenH, insets)
                        try {
                            wm.updateViewLayout(frame, lp)
                        } catch (_: Exception) {
                        }
                        bounds = Rect(lp.x, lp.y, lp.x + w, lp.y + h)
                    }
                }
                MotionEvent.ACTION_UP -> {
                    touching = false
                    if (moved) {
                        dropped(ctx, frame)
                    } else {
                        v.performClick()
                    }
                    dragging = false
                    frame.alpha = alphaNow
                    scheduleIdle()
                }
                MotionEvent.ACTION_CANCEL -> {
                    touching = false
                    if (moved) dropped(ctx, frame)
                    dragging = false
                    scheduleIdle()
                }
            }
            true
        }
    }

    private fun onTap(ctx: Context) {
        state = FloatLogic.next(state, FloatLogic.Event.TAP)
        render(ctx)
        scheduleIdle()
    }

    private fun action(ctx: Context, collapse: Boolean = true) {
        if (collapse) state = FloatLogic.next(state, FloatLogic.Event.ACTION)
        render(ctx)
        scheduleIdle()
        // The run state changes a moment later; look again soon instead of waiting for the next tick.
        main.postDelayed({ syncOnMain(ctx, true) }, 400)
    }

    /** Drag ended: snap to the nearer edge with a short ease-out, remember the position for this orientation. */
    private fun dropped(ctx: Context, box: View) {
        val w = lp.width
        val h = lp.height
        val land = screenW > screenH
        val dock = FloatLogic.dockFor(lp.x, lp.y, w, h, screenW, screenH, insets)
        scriptX = null
        scriptY = null
        Settings.setFloatDock(land, dock)
        dockRight = dock.right
        dragging = false
        val (tx, ty) = FloatLogic.place(dock, w, h, screenW, screenH, insets)
        val fromX = lp.x
        val fromY = lp.y
        animator?.cancel()
        animator = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 200
            interpolator = DecelerateInterpolator(1.6f)
            addUpdateListener {
                val f = it.animatedValue as Float
                moveTo(box, fromX + ((tx - fromX) * f).toInt(), fromY + ((ty - fromY) * f).toInt())
            }
            start()
        }
    }

    private fun startApp(ctx: Context, cls: Class<*>) {
        try {
            ctx.startActivity(Intent(ctx, cls).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: Exception) {
        }
    }
}
