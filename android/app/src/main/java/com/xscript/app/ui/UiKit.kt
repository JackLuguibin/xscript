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

    /** Screen scaffold: title bar + scrolling column. Returns the column. */
    fun screen(activity: Activity, title: String, subtitle: String? = null, back: Boolean = true): LinearLayout {
        val ctx = activity
        val p = palette(ctx)
        val outer = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(p.bg)
            fitsSystemWindows = true
        }
        val bar = LinearLayout(ctx).apply {
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
                setOnClickListener { activity.finish() }
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
        outer.addView(bar)
        val scroll = ScrollView(ctx).apply { isFillViewport = true }
        val column = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(ctx, 12f), dp(ctx, 4f), dp(ctx, 12f), dp(ctx, 24f))
        }
        scroll.addView(column)
        outer.addView(scroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        activity.setContentView(outer)
        column.tag = bar
        return column
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

    fun card(parent: LinearLayout): LinearLayout {
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
            topMargin = dp(ctx, 12f)
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
