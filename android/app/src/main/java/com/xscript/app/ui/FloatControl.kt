package com.xscript.app.ui

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import com.xscript.app.runtime.RunState
import com.xscript.app.runtime.ScriptService
import kotlin.math.abs

/**
 * Floating run controller shown while a script runs (main process). Tap ■ to stop,
 * tap the name to open the app, drag to move. Needs the overlay grant (悬浮窗权限).
 */
object FloatControl {
    private val main = Handler(Looper.getMainLooper())
    private var view: View? = null
    private var label: TextView? = null
    private val lp = WindowManager.LayoutParams()

    fun canShow(context: Context): Boolean = Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(context)

    fun show(context: Context, project: String?) {
        main.post { showOnMain(context.applicationContext, project) }
    }

    fun hide() {
        main.post {
            val v = view ?: return@post
            try {
                (v.context.getSystemService(Context.WINDOW_SERVICE) as WindowManager).removeView(v)
            } catch (_: Exception) {
            }
            view = null
            label = null
        }
    }

    private fun dp(ctx: Context, v: Float): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, ctx.resources.displayMetrics).toInt()

    @SuppressLint("ClickableViewAccessibility", "SetTextI18n")
    private fun showOnMain(ctx: Context, project: String?) {
        if (!canShow(ctx)) return
        if (view != null) {
            label?.text = project ?: "XScript"
            return
        }
        val wm = ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val bar = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            val pad = dp(ctx, 10f)
            setPadding(pad, dp(ctx, 6f), dp(ctx, 6f), dp(ctx, 6f))
            background = GradientDrawable().apply {
                cornerRadius = dp(ctx, 20f).toFloat()
                setColor(Color.argb(210, 28, 32, 38))
            }
        }
        val name = TextView(ctx).apply {
            text = project ?: "XScript"
            setTextColor(Color.WHITE)
            textSize = 13f
            maxWidth = dp(ctx, 140f)
            isSingleLine = true
            setOnClickListener {
                ctx.startActivity(Intent(ctx, com.xscript.app.LauncherActivity.home(ctx)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
        }
        val stop = TextView(ctx).apply {
            text = "■"
            gravity = Gravity.CENTER
            setTextColor(Color.WHITE)
            textSize = 14f
            val size = dp(ctx, 28f)
            layoutParams = LinearLayout.LayoutParams(size, size).apply { leftMargin = dp(ctx, 8f) }
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.parseColor("#FFE5484D"))
            }
            contentDescription = "停止脚本"
            setOnClickListener {
                ScriptService.stop(ctx)
                RunState.set(ctx, null)
                hide()
            }
        }
        bar.addView(name)
        bar.addView(stop)

        lp.width = WindowManager.LayoutParams.WRAP_CONTENT
        lp.height = WindowManager.LayoutParams.WRAP_CONTENT
        lp.type = if (Build.VERSION.SDK_INT >= 26) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_PHONE
        }
        lp.flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
        lp.format = PixelFormat.TRANSLUCENT
        lp.gravity = Gravity.TOP or Gravity.START
        if (lp.x == 0 && lp.y == 0) {
            lp.x = dp(ctx, 12f)
            lp.y = ctx.resources.displayMetrics.heightPixels / 3
        }

        var downX = 0f
        var downY = 0f
        var startX = 0
        var startY = 0
        var moved = false
        val drag = View.OnTouchListener { v, ev ->
            when (ev.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = ev.rawX; downY = ev.rawY; startX = lp.x; startY = lp.y; moved = false
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = ev.rawX - downX
                    val dy = ev.rawY - downY
                    if (moved || abs(dx) > 12 || abs(dy) > 12) {
                        moved = true
                        lp.x = startX + dx.toInt()
                        lp.y = startY + dy.toInt()
                        wm.updateViewLayout(bar, lp)
                    }
                }
                MotionEvent.ACTION_UP -> if (!moved) v.performClick()
            }
            true
        }
        name.setOnTouchListener(drag)
        try {
            wm.addView(bar, lp)
            view = bar
            label = name
        } catch (_: Exception) {
        }
    }
}
