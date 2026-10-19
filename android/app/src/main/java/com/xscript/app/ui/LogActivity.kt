package com.xscript.app.ui

import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.view.View
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
    private val ui by lazy { UiKit.palette(this) }
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var text: TextView
    private lateinit var scroll: ScrollView
    private lateinit var stopAction: TextView
    private lateinit var emptyHint: View
    private lateinit var logCard: View
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
            showEmpty(true)
        }
        scroll = col.parent as ScrollView
        emptyHint = UiKit.empty(col, "还没有日志", "运行小程序后，print 输出和报错会显示在这里")
        val card = UiKit.card(col, 8f)
        text = TextView(this).apply {
            typeface = Typeface.MONOSPACE
            textSize = 12f
            setTextColor(ui.text)
            setTextIsSelectable(true)
            val p = UiKit.dp(this@LogActivity, 12f)
            setPadding(p, p, p, p)
        }
        card.addView(text, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        logCard = card
        // Start from the last ~300 entries rather than the whole history.
        val (all, last) = LogBuffer.since(this, 0, limit = 300)
        append(all)
        showEmpty(buffer.isEmpty())
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
        // Disabled (not only dimmed) while nothing runs, so TalkBack reports it; set only on a change.
        val running = RunState.current(this) != null
        if (stopAction.isEnabled != running) {
            stopAction.isEnabled = running
            stopAction.alpha = if (running) 1f else 0.38f
        }
        showEmpty(buffer.isEmpty())
        val (entries, n) = LogBuffer.since(this, next)
        if (n < next) {
            buffer.clear()
        }
        next = n
        if (entries.isNotEmpty()) append(entries)
    }

    private fun showEmpty(empty: Boolean) {
        val hint = if (empty) View.VISIBLE else View.GONE
        if (emptyHint.visibility != hint) emptyHint.visibility = hint
        val log = if (empty) View.GONE else View.VISIBLE
        if (logCard.visibility != log) logCard.visibility = log
    }

    private fun append(entries: List<LogBuffer.Entry>) {
        val atBottom = !scroll.canScrollVertically(1)
        for (e in entries) {
            val start = buffer.length
            buffer.append(fmt.format(Date(e.ts))).append("  ").append(e.line.trimEnd('\n')).append('\n')
            if (e.stream == "stderr") {
                buffer.setSpan(ForegroundColorSpan(ui.danger), start, buffer.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
        }
        // Cap memory: keep the last ~200 KB.
        if (buffer.length > 200_000) buffer.delete(0, buffer.length - 150_000)
        text.text = buffer
        if (atBottom) scroll.post { scroll.fullScroll(ScrollView.FOCUS_DOWN) }
    }
}
