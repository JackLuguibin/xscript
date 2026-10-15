package com.xscript.app.ui

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings as AndroidSettings
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import com.xscript.app.runtime.RunState
import com.xscript.app.runtime.ScriptService
import com.xscript.app.settings.Settings
import org.json.JSONObject
import kotlin.math.abs

/**
 * Floating window (悬浮窗), main process. A small pill that docks to a screen edge and shows the run
 * state, project name and elapsed time; tapping it opens a panel with 运行/停止, 日志 and 打开.
 *
 * Visibility is decided by [FloatLogic.decide]: it appears when the app goes to the background while a
 * script runs (or always, with the setting "后台一直显示"), and hides again when one of our activities is
 * on screen or the script ends. No overlay grant = no window and no error. The window lives in the main
 * process, which the DeviceHttpService foreground notification keeps alive; [restore] re-creates it
 * after that process was restarted.
 */
object FloatControl {
    private val main = Handler(Looper.getMainLooper())

    // ---- state (main thread; the @Volatile ones are also read by /status on the HTTP thread) ----
    private var root: LinearLayout? = null
    private var pill: LinearLayout? = null
    private var panel: LinearLayout? = null
    private var dot: View? = null
    private var title: TextView? = null
    private var timer: TextView? = null
    private var toggle: TextView? = null
    private var lp = WindowManager.LayoutParams()
    private var state = FloatLogic.State()
    private var startedActivities = 0
    private var screenW = 0
    private var screenH = 0
    private var dragging = false
    private var animator: ValueAnimator? = null
    private var scriptForce: Boolean? = null
    private var observedSince = 0L
    private var idleConfirmed = false
    private var scriptX: Float? = null
    private var scriptY: Float? = null
    private var scriptDim = 1f

    @Volatile private var foreground = false
    @Volatile private var lastReason: FloatLogic.Reason? = FloatLogic.Reason.IDLE
    @Volatile private var bounds = Rect()
    @Volatile private var dockRight = FloatLogic.DEFAULT_DOCK.right
    @Volatile private var visibleNow = false
    @Volatile private var expandedNow = false
    @Volatile private var appCtx: Context? = null

    private const val TITLE = "XScriptFloat"
    private const val TICK_MS = 1000L

    fun canShow(context: Context): Boolean = Build.VERSION.SDK_INT < 23 || AndroidSettings.canDrawOverlays(context)

    /** Track whether one of our activities is on screen (main process only). Call once from Application.onCreate. */
    fun install(app: Application) {
        appCtx = app.applicationContext
        app.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
            override fun onActivityStarted(activity: Activity) {
                startedActivities++
                foreground = true
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
        main.post { syncOnMain(ctx) }
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
            root?.alpha = scriptDim
            root?.let { r -> r.post { reposition(r.context.applicationContext) } }
        }
        sync(context)
    }

    /** `ui.float_hide()` from a script: hide for this run. */
    fun forceHide(context: Context) {
        main.post { scriptForce = false }
        sync(context)
    }

    /** The script ended (or its process died): forget `ui.float_*` overrides and re-evaluate. */
    fun scriptEnded(context: Context) {
        main.post {
            scriptForce = null
            scriptX = null
            scriptY = null
            scriptDim = 1f
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
        androidx.appcompat.app.AlertDialog.Builder(activity)
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
        androidx.appcompat.app.AlertDialog.Builder(activity)
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
        val o = JSONObject()
            .put("enabled", Settings.floatOnRun)
            .put("always", Settings.floatAlways)
            .put("mode", Settings.floatMode)
            .put("permitted", canShow(context))
            .put("visible", visibleNow)
            .put("expanded", expandedNow)
            .put("app_foreground", foreground)
            .put("side", if (dockRight) "right" else "left")
            .put("reason", lastReason?.label ?: JSONObject.NULL)
        if (visibleNow) {
            o.put("x", b.left).put("y", b.top).put("width", b.width()).put("height", b.height())
        }
        return o
    }

    // ---- visibility ---------------------------------------------------------------------------

    private fun syncOnMain(ctx: Context) {
        val running = RunState.current(ctx) != null
        val d = FloatLogic.decide(canShow(ctx), Settings.floatOnRun, Settings.floatAlways, running, foreground, scriptForce)
        lastReason = d.reason
        if (!d.show) {
            // A run that just ended (or a status file read mid-update) must not flicker the window: confirm "idle" once more first.
            if (d.reason == FloatLogic.Reason.IDLE && root != null && !idleConfirmed) {
                idleConfirmed = true
                main.postDelayed({ syncOnMain(ctx) }, 600)
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
        state = FloatLogic.next(state, FloatLogic.Event.SHOW)
        render(ctx)
        main.removeCallbacks(tick)
        main.postDelayed(tick, TICK_MS)
    }

    private val tick = object : Runnable {
        override fun run() {
            val ctx = appCtx ?: return
            if (root == null) return
            syncOnMain(ctx)
            if (root != null) {
                // The screen can rotate or resize while the window is up.
                val (w, h) = screenSize(ctx)
                if (w != screenW || h != screenH) {
                    screenW = w; screenH = h
                    reposition(ctx)
                }
            }
        }
    }

    private fun removeView(ctx: Context) {
        main.removeCallbacks(tick)
        animator?.cancel()
        val v = root
        if (v != null) {
            try {
                (ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager).removeView(v)
            } catch (_: Exception) {
            }
        }
        root = null; pill = null; panel = null; dot = null; title = null; timer = null; toggle = null
        state = FloatLogic.next(state, FloatLogic.Event.HIDE)
        visibleNow = false
        expandedNow = false
        bounds = Rect()
    }

    // ---- rendering ----------------------------------------------------------------------------

    private fun dp(ctx: Context, v: Float): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, ctx.resources.displayMetrics).toInt()

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

    private fun render(ctx: Context) {
        val name = RunState.current(ctx)
        val running = name != null
        title?.text = name ?: "XScript 空闲"
        dot?.background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(if (running) Color.parseColor("#FF34C759") else Color.parseColor("#FF8E99A6"))
        }
        if (running) {
            val since = RunState.since(ctx) ?: observedSince.takeIf { it > 0 } ?: System.currentTimeMillis().also { observedSince = it }
            timer?.text = FloatLogic.formatElapsed(System.currentTimeMillis() - since)
            timer?.visibility = View.VISIBLE
        } else {
            observedSince = 0
            timer?.visibility = View.GONE
        }
        toggle?.apply {
            text = if (running) "■ 停止" else "▶ 运行"
            contentDescription = if (running) "停止脚本" else "运行脚本"
            (background as? GradientDrawable)?.setColor(Color.parseColor(if (running) "#FFE5484D" else "#FF2FA84F"))
        }
        panel?.visibility = if (state.expanded) View.VISIBLE else View.GONE
        expandedNow = state.expanded
        root?.contentDescription = "XScript 悬浮窗"
        root?.alpha = scriptDim
        root?.post { reposition(ctx) }
    }

    /** Put the window at its stored dock (unless the user is dragging it). */
    private fun reposition(ctx: Context) {
        val r = root ?: return
        if (dragging) return
        val w = r.width
        val h = r.height
        if (w == 0 || h == 0) return
        if (screenW == 0) screenSize(ctx).let { screenW = it.first; screenH = it.second }
        val stored = Settings.floatDock
        // ui.float_show(x, y) positions the window until the script ends or the user drags it.
        val dock = if (scriptX != null || scriptY != null) {
            FloatLogic.resolve(scriptX, scriptY, stored, w, h, screenW, screenH)
        } else {
            stored
        }
        dockRight = dock.right
        val (x, y) = FloatLogic.place(dock, w, h, screenW, screenH)
        moveTo(r, x, y)
    }

    private fun moveTo(r: View, x: Int, y: Int) {
        lp.x = x
        lp.y = y
        try {
            (r.context.getSystemService(Context.WINDOW_SERVICE) as WindowManager).updateViewLayout(r, lp)
        } catch (_: Exception) {
            return
        }
        r.visibility = View.VISIBLE
        bounds = Rect(x, y, x + r.width, y + r.height)
        visibleNow = true
    }

    private fun label(ctx: Context, text: String, desc: String, bg: String, onClick: () -> Unit) = TextView(ctx).apply {
        this.text = text
        contentDescription = desc
        gravity = Gravity.CENTER
        setTextColor(Color.WHITE)
        textSize = 12f
        val ph = dp(ctx, 10f)
        val pv = dp(ctx, 6f)
        setPadding(ph, pv, ph, pv)
        background = GradientDrawable().apply {
            cornerRadius = dp(ctx, 14f).toFloat()
            setColor(Color.parseColor(bg))
        }
        setOnClickListener { onClick() }
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun addView(ctx: Context): Boolean {
        if (!canShow(ctx)) return false
        val wm = ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        screenSize(ctx).let { screenW = it.first; screenH = it.second }

        val box = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            // Hidden until [reposition] has docked it, so it never flashes at the top-left corner.
            visibility = View.INVISIBLE
            val p = dp(ctx, 6f)
            setPadding(p, p, p, p)
            background = GradientDrawable().apply {
                cornerRadius = dp(ctx, 20f).toFloat()
                setColor(Color.argb(225, 28, 32, 38))
            }
        }
        val head = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(ctx, 6f), dp(ctx, 4f), dp(ctx, 8f), dp(ctx, 4f))
        }
        val d = View(ctx).apply { layoutParams = LinearLayout.LayoutParams(dp(ctx, 10f), dp(ctx, 10f)).apply { rightMargin = dp(ctx, 8f) } }
        val t = TextView(ctx).apply {
            setTextColor(Color.WHITE)
            textSize = 13f
            maxWidth = dp(ctx, 130f)
            isSingleLine = true
            ellipsize = android.text.TextUtils.TruncateAt.END
        }
        val tm = TextView(ctx).apply {
            setTextColor(Color.parseColor("#FFB8C2CC"))
            textSize = 12f
            typeface = android.graphics.Typeface.MONOSPACE
            setPadding(dp(ctx, 8f), 0, 0, 0)
        }
        head.addView(d)
        head.addView(t)
        head.addView(tm)

        val tg = label(ctx, "▶ 运行", "运行脚本", "#FF2FA84F") {
            val ctxNow = ctx
            if (RunState.current(ctxNow) != null) {
                ScriptService.stop(ctxNow)
                RunState.set(ctxNow, null)
            } else {
                val last = Settings.lastProject
                if (last.isNotEmpty() && com.xscript.app.project.ProjectStore(ctxNow).exists(last)) {
                    ScriptService.run(ctxNow, last)
                } else {
                    startApp(ctxNow, ProjectsActivity::class.java)
                }
            }
            action(ctxNow)
        }
        val logs = label(ctx, "日志", "查看日志", "#FF3A4350") {
            startApp(ctx, LogActivity::class.java)
            action(ctx)
        }
        val open = label(ctx, "打开", "打开应用", "#FF3A4350") {
            startApp(ctx, com.xscript.app.LauncherActivity.home(ctx))
            action(ctx)
        }
        val row = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            setPadding(0, dp(ctx, 4f), 0, dp(ctx, 2f))
        }
        for (b in listOf(tg, logs, open)) {
            row.addView(b, LinearLayout.LayoutParams(ViewGroupWrap, ViewGroupWrap).apply { marginStart = dp(ctx, 3f); marginEnd = dp(ctx, 3f) })
        }
        box.addView(head)
        box.addView(row)

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
            // Off-screen until the first layout pass has measured it, then [reposition] docks it.
            x = 0
            y = 0
        }
        lp = newLp

        var downX = 0f
        var downY = 0f
        var startX = 0
        var startY = 0
        var moved = false
        head.setOnTouchListener { _, ev ->
            when (ev.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    animator?.cancel()
                    downX = ev.rawX; downY = ev.rawY; startX = lp.x; startY = lp.y; moved = false
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = ev.rawX - downX
                    val dy = ev.rawY - downY
                    if (moved || abs(dx) > dp(ctx, 6f) || abs(dy) > dp(ctx, 6f)) {
                        moved = true
                        dragging = true
                        val w = box.width
                        val h = box.height
                        lp.x = FloatLogic.clamp(startX + dx.toInt(), 0, screenW - w)
                        lp.y = FloatLogic.clampY(startY + dy.toInt(), h, screenH)
                        try {
                            wm.updateViewLayout(box, lp)
                        } catch (_: Exception) {
                        }
                        bounds = Rect(lp.x, lp.y, lp.x + w, lp.y + h)
                    }
                }
                MotionEvent.ACTION_UP -> {
                    if (moved) dropped(ctx, box) else onTap(ctx)
                    dragging = false
                }
                MotionEvent.ACTION_CANCEL -> if (moved) dropped(ctx, box)
            }
            true
        }
        // Content width changes (timer digits, panel): keep a right-docked window flush with its edge.
        box.addOnLayoutChangeListener { v, l, _, r, _, ol, _, oldR, _ ->
            if (!dragging && (r - l) != (oldR - ol)) v.post { reposition(ctx) }
        }

        return try {
            wm.addView(box, lp)
            root = box; pill = head; panel = row; dot = d; title = t; timer = tm; toggle = tg
            true
        } catch (_: Exception) {
            // Overlay grant revoked meanwhile, or no window token: stay silent.
            false
        }
    }

    private const val ViewGroupWrap = LinearLayout.LayoutParams.WRAP_CONTENT

    private fun onTap(ctx: Context) {
        state = FloatLogic.next(state, FloatLogic.Event.TAP)
        render(ctx)
    }

    private fun action(ctx: Context) {
        state = FloatLogic.next(state, FloatLogic.Event.ACTION)
        render(ctx)
        // The run state changes a moment later; look again soon instead of waiting for the next tick.
        main.postDelayed({ syncOnMain(ctx) }, 400)
    }

    /** Drag ended: snap to the nearer edge, remember the position. */
    private fun dropped(ctx: Context, box: View) {
        val w = box.width
        val h = box.height
        val dock = FloatLogic.dockFor(lp.x, lp.y, w, h, screenW, screenH)
        scriptX = null
        scriptY = null
        Settings.floatDock = dock
        dockRight = dock.right
        dragging = false
        val (tx, ty) = FloatLogic.place(dock, w, h, screenW, screenH)
        val fromX = lp.x
        val fromY = lp.y
        animator?.cancel()
        animator = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 160
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
