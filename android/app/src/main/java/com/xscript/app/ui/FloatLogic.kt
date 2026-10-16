package com.xscript.app.ui

/**
 * Pure decisions behind the floating window (no Android types, so JVM tests cover them):
 * when it is visible, how it moves between ball / pill / panel, where it docks inside the safe area,
 * how long a run has gone.
 */
object FloatLogic {
    /** Why the window is hidden (reported by `/status` → `overlay.reason`). */
    enum class Reason(val label: String) {
        NO_PERMISSION("no_permission"),
        DISABLED("disabled"),
        FOREGROUND("foreground"),
        IDLE("idle"),
        SCRIPT_HIDDEN("script_hidden"),
        USER_HIDDEN("user_hidden"),
    }

    data class Decision(val show: Boolean, val reason: Reason?)

    /**
     * @param permitted overlay grant (悬浮窗权限)
     * @param enabled setting "运行时显示悬浮窗"
     * @param always setting "后台一直显示" (also while no script runs)
     * @param running a script is running
     * @param appForeground one of our activities is on screen
     * @param scriptForce `ui.float_show()` = true / `ui.float_hide()` = false for the current run, null = not called
     * @param userHidden the user tapped 隐藏 in the panel (until the next run or until the app is opened)
     * @param notice a run just ended with an error: keep the window up for a few seconds so it is seen
     */
    fun decide(
        permitted: Boolean,
        enabled: Boolean,
        always: Boolean,
        running: Boolean,
        appForeground: Boolean,
        scriptForce: Boolean? = null,
        userHidden: Boolean = false,
        notice: Boolean = false,
    ): Decision = when {
        !permitted -> Decision(false, Reason.NO_PERMISSION)
        scriptForce == true -> Decision(true, null)
        scriptForce == false -> Decision(false, Reason.SCRIPT_HIDDEN)
        userHidden -> Decision(false, Reason.USER_HIDDEN)
        !enabled -> Decision(false, Reason.DISABLED)
        appForeground -> Decision(false, Reason.FOREGROUND)
        running || always || notice -> Decision(true, null)
        else -> Decision(false, Reason.IDLE)
    }

    /** A run that ended on its own with a non-zero exit or a dead process is an error; a user stop or exit 0 is not. */
    fun isError(exit: String?): Boolean = when (exit?.trim()) {
        null, "" , "0", "stopped" -> false
        else -> true
    }

    // ---- ball / pill / panel state machine ----------------------------------------------------

    /** BALL: small, dimmed, docked (after a few idle seconds). PILL: dot + name + time. PANEL: PILL plus buttons. */
    enum class Mode(val label: String) { BALL("ball"), PILL("pill"), PANEL("panel") }

    data class State(val visible: Boolean = false, val mode: Mode = Mode.PILL) {
        val expanded: Boolean get() = mode == Mode.PANEL
    }

    enum class Event { SHOW, HIDE, TAP, ACTION, IDLE, WAKE }

    const val PILL_IDLE_MS = 5_000L
    const val PANEL_IDLE_MS = 10_000L

    /**
     * SHOW/HIDE follow [decide] (a window that appears starts as a PILL so the name is readable);
     * TAP opens the panel from a ball or pill and closes it again to the pill; ACTION (a panel button
     * was used) returns to the pill; IDLE (no touch for [PILL_IDLE_MS] / [PANEL_IDLE_MS]) shrinks to the
     * ball; WAKE (drag, new error) turns a ball back into the pill. Nothing reacts while hidden.
     */
    fun next(s: State, e: Event): State = when (e) {
        Event.SHOW -> if (s.visible) s else State(visible = true, mode = Mode.PILL)
        Event.HIDE -> State(visible = false, mode = Mode.PILL)
        else -> if (!s.visible) s else when (e) {
            Event.TAP -> s.copy(mode = if (s.mode == Mode.PANEL) Mode.PILL else Mode.PANEL)
            Event.ACTION -> s.copy(mode = Mode.PILL)
            Event.IDLE -> s.copy(mode = Mode.BALL)
            Event.WAKE -> if (s.mode == Mode.BALL) s.copy(mode = Mode.PILL) else s
            else -> s
        }
    }

    fun idleMs(mode: Mode): Long? = when (mode) {
        Mode.PILL -> PILL_IDLE_MS
        Mode.PANEL -> PANEL_IDLE_MS
        Mode.BALL -> null
    }

    /** Window opacity: the script's `dim` (0.1–1) normally, never more than [BALL_ALPHA] × dim for the idle ball. */
    const val BALL_ALPHA = 0.6f

    fun alpha(mode: Mode, dim: Float, touching: Boolean = false): Float {
        val d = if (dim.isNaN()) 1f else dim.coerceIn(0.1f, 1f)
        return if (mode == Mode.BALL && !touching) d * BALL_ALPHA else d
    }

    // ---- position ---------------------------------------------------------------------------

    /** Screen areas the window must stay out of (status bar, camera cut-out, navigation / gesture bar), in px. */
    data class Insets(val left: Int = 0, val top: Int = 0, val right: Int = 0, val bottom: Int = 0) {
        companion object { val NONE = Insets() }
    }

    /** Where the window rests: at the left or right edge, [yFrac] of the usable height down. */
    data class Dock(val right: Boolean, val yFrac: Float)

    val DEFAULT_DOCK = Dock(right = true, yFrac = 0.6f)

    fun clamp(v: Int, lo: Int, hi: Int): Int = if (hi < lo) lo else minOf(maxOf(v, lo), hi)

    /** Top-left y that keeps a window of height [h] inside the safe area. */
    fun clampY(y: Int, h: Int, screenH: Int, insets: Insets = Insets.NONE): Int =
        clamp(y, insets.top, screenH - insets.bottom - h)

    fun clampX(x: Int, w: Int, screenW: Int, insets: Insets = Insets.NONE): Int =
        clamp(x, insets.left, screenW - insets.right - w)

    /** Edge-snapping (AScript: 坐标为 0/-1 时自动缩边): the nearer screen edge for a window dropped at [x]. */
    fun snapRight(x: Int, w: Int, screenW: Int): Boolean = x + w / 2 >= screenW / 2

    fun dockX(right: Boolean, w: Int, screenW: Int, insets: Insets = Insets.NONE): Int =
        if (right) maxOf(insets.left, screenW - insets.right - w) else insets.left

    /** The dock for a window dropped at (x, y). */
    fun dockFor(x: Int, y: Int, w: Int, h: Int, screenW: Int, screenH: Int, insets: Insets = Insets.NONE): Dock {
        val span = maxOf(1, screenH - insets.top - insets.bottom - h)
        return Dock(snapRight(x, w, screenW), clampFrac((clampY(y, h, screenH, insets) - insets.top).toFloat() / span))
    }

    /** Top-left (x, y) of the window for a stored [dock] on this screen. */
    fun place(dock: Dock, w: Int, h: Int, screenW: Int, screenH: Int, insets: Insets = Insets.NONE): Pair<Int, Int> {
        val span = maxOf(0, screenH - insets.top - insets.bottom - h)
        return dockX(dock.right, w, screenW, insets) to
            clampY(insets.top + (clampFrac(dock.yFrac) * span).toInt(), h, screenH, insets)
    }

    /**
     * AScript `FloatWindow.show(x, y)` → a dock. -1 = far edge (right / bottom), 0 = near edge (left / top),
     * a decimal below 1 = share of the screen, 1 and up = pixels. XScript always rests on a side edge, so a
     * pixel or percentage x only chooses the nearer side. null keeps [current].
     */
    fun resolve(
        x: Float?, y: Float?, current: Dock, w: Int, h: Int, screenW: Int, screenH: Int,
        insets: Insets = Insets.NONE,
    ): Dock {
        val right = when {
            x == null -> current.right
            x == -1f -> true
            x == 0f -> false
            x < 1f -> snapRight((x * screenW).toInt(), w, screenW)
            else -> snapRight(x.toInt(), w, screenW)
        }
        val span = maxOf(1, screenH - insets.top - insets.bottom - h)
        val frac = when {
            y == null -> current.yFrac
            y == -1f -> 1f
            y == 0f -> 0f
            y < 1f -> clampFrac((y * screenH - insets.top) / span)
            else -> clampFrac((clampY(y.toInt(), h, screenH, insets) - insets.top).toFloat() / span)
        }
        return Dock(right, clampFrac(frac))
    }

    fun clampFrac(f: Float): Float = if (f.isNaN()) DEFAULT_DOCK.yFrac else minOf(1f, maxOf(0f, f))

    // ---- text --------------------------------------------------------------------------------

    /** `m:ss`, or `h:mm:ss` from one hour on. Negative or unknown spans read 0:00. */
    fun formatElapsed(ms: Long): String {
        val total = maxOf(0L, ms) / 1000
        val h = total / 3600
        val m = (total % 3600) / 60
        val s = total % 60
        return if (h > 0) String.format(java.util.Locale.ROOT, "%d:%02d:%02d", h, m, s) else String.format(java.util.Locale.ROOT, "%d:%02d", m, s)
    }

    /** The few characters that fit in the 48dp ball: `m:ss`, `1h02` from one hour on. */
    fun formatBall(ms: Long): String {
        val total = maxOf(0L, ms) / 1000
        val h = total / 3600
        return if (h > 0) String.format(java.util.Locale.ROOT, "%dh%02d", h, (total % 3600) / 60) else formatElapsed(ms)
    }
}
