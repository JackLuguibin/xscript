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

/** Small programmatic view kit for the AScript-style grouped list screens. */
object UiKit {
    const val BG = 0xFFF2F3F5.toInt()
    const val CARD = 0xFFFFFFFF.toInt()
    const val TEXT = 0xFF1F2329.toInt()
    const val MUTED = 0xFF8F959E.toInt()
    const val GREEN = 0xFF34A853.toInt()
    const val RED = 0xFFE5484D.toInt()
    const val BLUE = 0xFF2F7CF6.toInt()
    const val DIVIDER = 0xFFEDEEF0.toInt()

    fun dp(ctx: Context, v: Float): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, ctx.resources.displayMetrics).toInt()

    class Row(val root: View, val title: TextView, val value: TextView) {
        fun value(text: CharSequence, color: Int = MUTED) {
            value.text = text
            value.setTextColor(color)
        }
    }

    /** Screen scaffold: title bar + scrolling column. Returns the column. */
    fun screen(activity: Activity, title: String, subtitle: String? = null, back: Boolean = true): LinearLayout {
        val ctx = activity
        val outer = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(BG)
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
                setTextColor(TEXT)
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
            setTextColor(TEXT)
        })
        if (subtitle != null) {
            titles.addView(TextView(ctx).apply {
                text = subtitle
                textSize = 12f
                setTextColor(MUTED)
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
            setTextColor(BLUE)
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
                setColor(CARD)
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
        if (card.childCount > 0) {
            card.addView(View(ctx).apply { setBackgroundColor(DIVIDER) }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 1).apply {
                leftMargin = dp(ctx, if (glyph != null) 60f else 16f)
            })
        }
        val line = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            minimumHeight = dp(ctx, 56f)
            setPadding(dp(ctx, 14f), dp(ctx, 8f), dp(ctx, 12f), dp(ctx, 8f))
            if (onClick != null) {
                background = ripple(CARD, 0f, ctx)
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
            setTextColor(TEXT)
        }
        line.addView(t, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        val v = TextView(ctx).apply {
            text = value
            textSize = 13f
            setTextColor(MUTED)
            maxWidth = dp(ctx, 200f)
            isSingleLine = true
            ellipsize = android.text.TextUtils.TruncateAt.MIDDLE
        }
        line.addView(v)
        if (chevron) {
            line.addView(TextView(ctx).apply {
                text = "›"
                textSize = 20f
                setTextColor(0xFFC0C4CC.toInt())
                setPadding(dp(ctx, 8f), 0, 0, dp(ctx, 2f))
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            })
        }
        card.addView(line)
        return Row(line, t, v)
    }

    fun note(parent: LinearLayout, text: String): TextView {
        val ctx = parent.context
        val tv = TextView(ctx).apply {
            this.text = text
            textSize = 12f
            setTextColor(MUTED)
            setPadding(dp(ctx, 8f), dp(ctx, 10f), dp(ctx, 8f), 0)
        }
        parent.addView(tv)
        return tv
    }

    fun button(ctx: Context, label: String, color: Int, onClick: () -> Unit): TextView = TextView(ctx).apply {
        text = label
        textSize = 15f
        setTextColor(Color.WHITE)
        gravity = Gravity.CENTER
        setTypeface(typeface, Typeface.BOLD)
        setPadding(dp(ctx, 18f), dp(ctx, 10f), dp(ctx, 18f), dp(ctx, 10f))
        background = ripple(color, 22f, ctx)
        minHeight = dp(ctx, 44f)
        setOnClickListener { onClick() }
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
        return RippleDrawable(ColorStateList.valueOf(0x22000000), shape, mask)
    }

    fun spacer(parent: ViewGroup, heightDp: Float) {
        parent.addView(FrameLayout(parent.context), ViewGroup.LayoutParams(1, dp(parent.context, heightDp)))
    }
}
