package com.xscript.app.ui

import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.content.res.ColorStateList
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import com.google.android.material.materialswitch.MaterialSwitch
import androidx.core.view.WindowInsetsCompat
import com.xscript.app.R

/** Small programmatic view kit for the AScript-style grouped list screens. */
object UiKit {
    /** Color tokens of the current theme (res/values and res/values-night colors.xml). Activities keep one. */
    class Palette(ctx: Context) {
        val bg = ctx.getColor(R.color.xscript_bg)
        val card = ctx.getColor(R.color.xscript_card)
        val text = ctx.getColor(R.color.xscript_text)
        val muted = ctx.getColor(R.color.xscript_muted)
        val divider = ctx.getColor(R.color.xscript_divider)
        val chevron = ctx.getColor(R.color.xscript_chevron)
        val ripple = ctx.getColor(R.color.xscript_ripple)
        val accent = ctx.getColor(R.color.xscript_accent)
        val success = ctx.getColor(R.color.xscript_success)
        val danger = ctx.getColor(R.color.xscript_danger)

        /** Container and content colors of a filled button. */
        fun fill(tone: Tone, ctx: Context): Pair<Int, Int> = when (tone) {
            Tone.PRIMARY -> accent to ctx.getColor(R.color.xscript_on_accent)
            Tone.SUCCESS -> success to ctx.getColor(R.color.xscript_on_success)
            Tone.DANGER -> danger to ctx.getColor(R.color.xscript_on_danger)
            Tone.NEUTRAL -> ctx.getColor(R.color.xscript_neutral) to ctx.getColor(R.color.xscript_on_neutral)
        }
    }

    /** Filled button roles. */
    enum class Tone { PRIMARY, SUCCESS, DANGER, NEUTRAL }

    fun palette(ctx: Context) = Palette(ctx)

    fun dp(ctx: Context, v: Float): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, ctx.resources.displayMetrics).toInt()

    class Row(val root: View, val title: TextView, val value: TextView, private val muted: Int) {
        fun value(text: CharSequence, color: Int = muted) {
            setText(value, text)
            if (value.currentTextColor != color) value.setTextColor(color)
        }
    }

    /** Plain-text equality, so a status that did not change is not set again. */
    fun sameText(a: CharSequence?, b: CharSequence?): Boolean = a?.toString() == b?.toString()

    /**
     * Sets the text only when it changed. TextView.setText redraws (and may re-layout) even for the same string,
     * and the home screen re-applies every status row each 1.5 s.
     */
    fun setText(view: TextView, text: CharSequence) {
        if (!sameText(view.text, text)) view.text = text
    }

    /** Widest the title bar and content get, in dp; wider windows (tablets, landscape) center them. */
    const val MAX_CONTENT_DP = 640f

    /** Left, top, right and bottom sizes in px (system bar, cutout or keyboard insets). */
    data class Edges(val left: Int, val top: Int, val right: Int, val bottom: Int)

    /** Padding of the whole screen: the bars and cutout on the top and sides; the bottom is the content's. */
    fun screenPadding(bars: Edges): Edges = Edges(bars.left, bars.top, bars.right, 0)

    /**
     * Bottom padding of the scrolling content: its own [base] plus the navigation bar, or the keyboard when it is
     * taller, so the last row scrolls clear of both while the list still draws behind the gesture bar.
     */
    fun contentBottom(base: Int, bars: Edges, imeBottom: Int): Int = base + maxOf(bars.bottom, imeBottom)

    /** Width a column measures to: the window's, capped at [maxPx]. */
    fun cappedWidth(available: Int, maxPx: Int): Int = minOf(available, maxPx)

    /** A vertical/horizontal LinearLayout no wider than [maxPx]; its parent centers it. */
    private class Capped(ctx: Context, private val maxPx: Int) : LinearLayout(ctx) {
        override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
            val mode = MeasureSpec.getMode(widthMeasureSpec)
            val size = MeasureSpec.getSize(widthMeasureSpec)
            val spec = if (mode == MeasureSpec.UNSPECIFIED) widthMeasureSpec
            else MeasureSpec.makeMeasureSpec(cappedWidth(size, maxPx), mode)
            super.onMeasure(spec, heightMeasureSpec)
        }
    }

    /**
     * Screen scaffold: title bar + scrolling column. Returns the column. Draws edge to edge: the bars are
     * transparent and the window insets are applied as padding (bar on top and sides, content bottom).
     */
    fun screen(activity: Activity, title: String, subtitle: String? = null, back: Boolean = true): LinearLayout {
        val ctx = activity
        val p = palette(ctx)
        (activity as? ComponentActivity)?.enableEdgeToEdge(
            SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT),
            SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT),
        )
        val maxPx = dp(ctx, MAX_CONTENT_DP)
        val outer = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setBackgroundColor(p.bg)
        }
        val bar = Capped(ctx, maxPx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(ctx, if (back) 4f else 20f), dp(ctx, 10f), dp(ctx, 16f), dp(ctx, 6f))
        }
        if (back) {
            bar.addView(TextView(ctx).apply {
                text = "‹"
                textSize = 30f
                setTextColor(p.text)
                gravity = Gravity.CENTER
                contentDescription = "返回"
                layoutParams = LinearLayout.LayoutParams(dp(ctx, 44f), dp(ctx, 44f))
                background = ripple(Color.TRANSPARENT, 22f, ctx)
                // Through the back dispatcher, so a screen's own back handling (the editor's unsaved-changes prompt)
                // runs for the arrow too; without one the dispatcher finishes the activity.
                setOnClickListener { navigateBack(activity) }
            })
        }
        val titles = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        titles.addView(TextView(ctx).apply {
            text = title
            textSize = 20f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(p.text)
        })
        if (subtitle != null) {
            titles.addView(TextView(ctx).apply {
                text = subtitle
                textSize = 12f
                setTextColor(p.muted)
            })
        }
        bar.addView(titles, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        outer.addView(bar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        val scroll = ScrollView(ctx).apply { isFillViewport = true }
        val bottom = dp(ctx, 24f)
        val column = Capped(ctx, maxPx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(ctx, 12f), dp(ctx, 4f), dp(ctx, 12f), bottom)
        }
        scroll.addView(column, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER_HORIZONTAL))
        outer.addView(scroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        ViewCompat.setOnApplyWindowInsetsListener(outer) { v, insets ->
            val i = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val bars = Edges(i.left, i.top, i.right, i.bottom)
            val pad = screenPadding(bars)
            v.setPadding(pad.left, pad.top, pad.right, pad.bottom)
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
            column.setPadding(column.paddingLeft, column.paddingTop, column.paddingRight, contentBottom(bottom, bars, ime))
            WindowInsetsCompat.CONSUMED
        }
        activity.setContentView(outer)
        column.tag = bar
        return column
    }

    fun navigateBack(activity: Activity) {
        val dispatcher = (activity as? ComponentActivity)?.onBackPressedDispatcher
        if (dispatcher != null) dispatcher.onBackPressed() else activity.finish()
    }

    /** Action text button on the title bar created by [screen]. */
    fun barAction(column: LinearLayout, label: String, onClick: () -> Unit): TextView {
        val bar = column.tag as LinearLayout
        val ctx = column.context
        val tv = TextView(ctx).apply {
            text = label
            textSize = 14f
            setTextColor(palette(ctx).accent)
            gravity = Gravity.CENTER
            setPadding(dp(ctx, 10f), dp(ctx, 8f), dp(ctx, 10f), dp(ctx, 8f))
            background = ripple(Color.TRANSPARENT, 16f, ctx)
            setOnClickListener { onClick() }
        }
        bar.addView(tv)
        return tv
    }

    /** Header above a card: [title] and an optional trailing summary, marked as a heading for TalkBack. */
    class Section(val title: TextView, val value: TextView)

    fun section(parent: LinearLayout, title: String): Section {
        val ctx = parent.context
        val p = palette(ctx)
        val line = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(ctx, 16f), dp(ctx, 20f), dp(ctx, 16f), 0)
        }
        val t = TextView(ctx).apply {
            text = title
            textSize = 13f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(p.muted)
            ViewCompat.setAccessibilityHeading(this, true)
        }
        line.addView(t, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        val v = TextView(ctx).apply {
            textSize = 12f
            setTextColor(p.muted)
        }
        line.addView(v)
        parent.addView(line)
        return Section(t, v)
    }

    /** A small round status dot; [dotColor] repaints it only when the color changes. */
    fun dot(ctx: Context, color: Int): View = View(ctx).apply {
        background = GradientDrawable().apply { shape = GradientDrawable.OVAL }
        dotColor(this, color)
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }

    fun dotColor(dot: View, color: Int) {
        if (dot.getTag(R.id.xscript_tone) == color) return
        dot.setTag(R.id.xscript_tone, color)
        (dot.background as GradientDrawable).setColor(color)
    }

    fun card(parent: LinearLayout, topMarginDp: Float = 12f): LinearLayout {
        val ctx = parent.context
        val card = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                cornerRadius = dp(ctx, 16f).toFloat()
                setColor(palette(ctx).card)
            }
            clipToOutline = true
        }
        parent.addView(card, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            topMargin = dp(ctx, topMarginDp)
        })
        return card
    }

    fun icon(ctx: Context, glyph: String, color: Int): View = TextView(ctx).apply {
        text = glyph
        textSize = 15f
        setTextColor(Color.WHITE)
        gravity = Gravity.CENTER
        setTypeface(typeface, Typeface.BOLD)
        background = GradientDrawable().apply {
            cornerRadius = dp(ctx, 9f).toFloat()
            setColor(color)
        }
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }

    fun row(
        card: LinearLayout,
        glyph: String?,
        color: Int,
        title: String,
        value: String = "",
        chevron: Boolean = true,
        onClick: (() -> Unit)? = null,
    ): Row {
        val ctx = card.context
        val p = palette(ctx)
        if (card.childCount > 0) {
            card.addView(View(ctx).apply { setBackgroundColor(p.divider) }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 1).apply {
                leftMargin = dp(ctx, if (glyph != null) 60f else 16f)
            })
        }
        val line = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            minimumHeight = dp(ctx, 56f)
            setPadding(dp(ctx, 14f), dp(ctx, 8f), dp(ctx, 12f), dp(ctx, 8f))
            if (onClick != null) {
                background = ripple(p.card, 0f, ctx)
                isClickable = true
                setOnClickListener { onClick() }
            }
        }
        if (glyph != null) {
            val size = dp(ctx, 32f)
            line.addView(icon(ctx, glyph, color), LinearLayout.LayoutParams(size, size).apply { rightMargin = dp(ctx, 14f) })
        }
        val t = TextView(ctx).apply {
            text = title
            textSize = 16f
            setTextColor(p.text)
        }
        line.addView(t, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        val v = TextView(ctx).apply {
            text = value
            textSize = 13f
            setTextColor(p.muted)
            maxWidth = dp(ctx, 200f)
            isSingleLine = true
            ellipsize = android.text.TextUtils.TruncateAt.MIDDLE
        }
        line.addView(v)
        if (chevron) {
            line.addView(TextView(ctx).apply {
                text = "›"
                textSize = 20f
                setTextColor(p.chevron)
                setPadding(dp(ctx, 8f), 0, 0, dp(ctx, 2f))
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            })
        }
        card.addView(line)
        return Row(line, t, v, p.muted)
    }

    /** A row with a trailing Material switch; tapping the row or the switch calls [onToggle] with the new state. */
    fun switchRow(card: LinearLayout, glyph: String?, color: Int, title: String, checked: Boolean, onToggle: (Boolean) -> Unit): Row {
        val ctx = card.context
        lateinit var sw: MaterialSwitch
        val row = row(card, glyph, color, title, chevron = false) { sw.toggle() }
        sw = MaterialSwitch(ctx).apply {
            isChecked = checked
            // The row reads as one control: TalkBack announces the title with the switch state.
            contentDescription = title
            setOnCheckedChangeListener { _, on -> onToggle(on) }
        }
        (row.root as LinearLayout).addView(sw)
        row.root.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        return row
    }

    /**
     * Empty state: a centered card with a [title], a [body] and up to two actions (the first filled, the second
     * tonal), instead of a plain row.
     */
    fun empty(parent: LinearLayout, title: String, body: String, vararg actions: Pair<String, () -> Unit>): LinearLayout {
        val ctx = parent.context
        val p = palette(ctx)
        val card = card(parent)
        card.gravity = Gravity.CENTER_HORIZONTAL
        val pad = dp(ctx, 24f)
        card.setPadding(pad, dp(ctx, 32f), pad, pad)
        card.addView(TextView(ctx).apply {
            text = title
            textSize = 17f
            gravity = Gravity.CENTER
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(p.text)
        })
        card.addView(TextView(ctx).apply {
            text = body
            textSize = 13f
            gravity = Gravity.CENTER
            setTextColor(p.muted)
            setPadding(0, dp(ctx, 6f), 0, 0)
        })
        if (actions.isNotEmpty()) {
            val line = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER
                setPadding(0, dp(ctx, 20f), 0, 0)
            }
            actions.forEachIndexed { i, (label, onClick) ->
                line.addView(button(ctx, label, if (i == 0) Tone.PRIMARY else Tone.NEUTRAL, onClick),
                    LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                        if (i > 0) leftMargin = dp(ctx, 12f)
                    })
            }
            card.addView(line)
        }
        return card
    }

    fun note(parent: LinearLayout, text: String): TextView {
        val ctx = parent.context
        val tv = TextView(ctx).apply {
            this.text = text
            textSize = 12f
            setTextColor(palette(ctx).muted)
            setPadding(dp(ctx, 8f), dp(ctx, 10f), dp(ctx, 8f), 0)
        }
        parent.addView(tv)
        return tv
    }

    fun button(ctx: Context, label: String, tone: Tone, onClick: () -> Unit): TextView = TextView(ctx).apply {
        text = label
        textSize = 15f
        gravity = Gravity.CENTER
        setTypeface(typeface, Typeface.BOLD)
        setPadding(dp(ctx, 18f), dp(ctx, 10f), dp(ctx, 18f), dp(ctx, 10f))
        minHeight = dp(ctx, 44f)
        paint(this, tone)
        setOnClickListener { onClick() }
    }

    /**
     * Colors a [button] for [tone]. Runs on status ticks, so an unchanged tone is a no-op: a new background
     * drawable would redraw the button every tick.
     */
    fun paint(button: TextView, tone: Tone) {
        if (button.getTag(R.id.xscript_tone) == tone) return
        button.setTag(R.id.xscript_tone, tone)
        val (container, content) = palette(button.context).fill(tone, button.context)
        button.background = ripple(container, 22f, button.context)
        button.setTextColor(content)
    }

    fun ripple(color: Int, radiusDp: Float, ctx: Context): RippleDrawable {
        val shape = GradientDrawable().apply {
            cornerRadius = dp(ctx, radiusDp).toFloat()
            setColor(color)
        }
        val mask = GradientDrawable().apply {
            cornerRadius = dp(ctx, radiusDp).toFloat()
            setColor(Color.WHITE)
        }
        return RippleDrawable(ColorStateList.valueOf(palette(ctx).ripple), shape, mask)
    }

    fun spacer(parent: ViewGroup, heightDp: Float) {
        parent.addView(FrameLayout(parent.context), ViewGroup.LayoutParams(1, dp(parent.context, heightDp)))
    }
}
