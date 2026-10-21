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

    /** Set when opened from 最近运行: show only that run's lines (seq in (from, to]) and do not follow new ones. */
    private var range: LongRange? = null

    private val tick = object : Runnable {
        override fun run() {
            poll()
            handler.postDelayed(this, 700)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val from = intent.getLongExtra(EXTRA_FROM, -1L)
        val to = intent.getLongExtra(EXTRA_TO, -1L)
        if (from >= 0 && to >= from) range = (from + 1)..to
        val col = UiKit.screen(this, intent.getStringExtra(EXTRA_TITLE) ?: "运行日志")
        stopAction = UiKit.barAction(col, "停止") { ScriptService.stop(this) }
        if (range == null) {
            UiKit.barAction(col, "清空") {
                LogBuffer.clear(this)
                buffer.clear()
                text.text = ""
                showEmpty(true)
            }
        }
        scroll = col.parent as ScrollView
        emptyHint = if (range == null) {
            UiKit.empty(col, "还没有日志", "运行小程序后，print 输出和报错会显示在这里")
        } else {
            UiKit.empty(col, "这次运行的日志已经没有了", "日志被清空过，或已被更新的日志挤掉（最多保留约 2 MB）")
        }
        val card = UiKit.card(col, UiKit.Space.S)
        text = TextView(this).apply {
            typeface = Typeface.MONOSPACE
            textSize = UiKit.Type.CAPTION
            setTextColor(ui.text)
            setTextIsSelectable(true)
            val p = UiKit.dp(this@LogActivity, UiKit.Space.M)
            setPadding(p, p, p, p)
        }
        card.addView(text, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        logCard = card
        val r = range
        if (r != null) {
            val (entries, _) = LogBuffer.since(this, r.first - 1, limit = 20000)
            val mine = entries.filter { it.seq in r }
            if (mine.isNotEmpty() && mine.first().seq > r.first) {
                UiKit.note(col, "开头部分已被更新的日志挤掉，只剩后面 ${mine.size} 行。")
            }
            append(mine)
            showEmpty(buffer.isEmpty())
            return
        }
        // Start from the last ~300 entries rather than the whole history.
        val (all, last) = LogBuffer.since(this, 0, limit = 300)
        append(all)
        showEmpty(buffer.isEmpty())
        next = last
    }

    override fun onResume() {
        super.onResume()
        if (range == null) handler.post(tick) else updateStop()
    }

    private fun updateStop() {
        // Disabled (not only dimmed) while nothing runs, so TalkBack reports it; set only on a change.
        val running = RunState.current(this) != null
        if (stopAction.isEnabled != running) {
            stopAction.isEnabled = running
            stopAction.alpha = if (running) 1f else 0.38f
        }
    }

    override fun onPause() {
        handler.removeCallbacks(tick)
        super.onPause()
    }

    private fun poll() {
        updateStop()
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

    companion object {
        const val EXTRA_FROM = "log_from"
        const val EXTRA_TO = "log_to"
        const val EXTRA_TITLE = "title"
    }
}
