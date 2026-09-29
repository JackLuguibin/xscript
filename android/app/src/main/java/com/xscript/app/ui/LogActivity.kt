package com.xscript.app.ui

import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.xscript.app.runtime.LogBuffer
import com.xscript.app.runtime.RunState
import com.xscript.app.runtime.ScriptService
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Live tail of the runtime log (stdout black, stderr red). */
class LogActivity : AppCompatActivity() {
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var text: TextView
    private lateinit var scroll: ScrollView
    private lateinit var stopAction: TextView
    private var next = 0L
    private val buffer = SpannableStringBuilder()
    private val fmt = SimpleDateFormat("HH:mm:ss", Locale.getDefault())

    private val tick = object : Runnable {
        override fun run() {
            poll()
            handler.postDelayed(this, 700)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val col = UiKit.screen(this, "运行日志")
        stopAction = UiKit.barAction(col, "停止") { ScriptService.stop(this) }
        UiKit.barAction(col, "清空") {
            LogBuffer.clear(this)
            buffer.clear()
            text.text = ""
        }
        scroll = col.parent as ScrollView
        text = TextView(this).apply {
            typeface = Typeface.MONOSPACE
            textSize = 12f
            setTextColor(UiKit.TEXT)
            setTextIsSelectable(true)
            setBackgroundColor(UiKit.CARD)
            val p = UiKit.dp(this@LogActivity, 12f)
            setPadding(p, p, p, p)
        }
        col.addView(text, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            topMargin = UiKit.dp(this@LogActivity, 8f)
        })
        // Start from the last ~300 entries rather than the whole history.
        val (all, last) = LogBuffer.since(this, 0, limit = 300)
        append(all)
        next = last
    }

    override fun onResume() {
        super.onResume()
        handler.post(tick)
    }

    override fun onPause() {
        handler.removeCallbacks(tick)
        super.onPause()
    }

    private fun poll() {
        stopAction.alpha = if (RunState.current(this) != null) 1f else 0.3f
        val (entries, n) = LogBuffer.since(this, next)
        if (n < next) {
            buffer.clear()
        }
        next = n
        if (entries.isNotEmpty()) append(entries)
    }

    private fun append(entries: List<LogBuffer.Entry>) {
        val atBottom = !scroll.canScrollVertically(1)
        for (e in entries) {
            val start = buffer.length
            buffer.append(fmt.format(Date(e.ts))).append("  ").append(e.line.trimEnd('\n')).append('\n')
            if (e.stream == "stderr") {
                buffer.setSpan(ForegroundColorSpan(UiKit.RED), start, buffer.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
        }
        // Cap memory: keep the last ~200 KB.
        if (buffer.length > 200_000) buffer.delete(0, buffer.length - 150_000)
        text.text = buffer
        if (atBottom) scroll.post { scroll.fullScroll(ScrollView.FOCUS_DOWN) }
    }
}
