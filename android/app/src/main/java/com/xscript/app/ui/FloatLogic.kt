package com.xscript.app.ui

/**
 * Pure decisions behind the floating window (no Android types, so JVM tests cover them):
 * when it is visible, how the expanded panel reacts to taps, where it docks, how long a run has gone.
 */
object FloatLogic {
    /** Why the window is hidden (reported by `/status` → `overlay.reason`). */
    enum class Reason(val label: String) {
        NO_PERMISSION("no_permission"),
        DISABLED("disabled"),
        FOREGROUND("foreground"),
        IDLE("idle"),
        SCRIPT_HIDDEN("script_hidden"),
    }

    data class Decision(val show: Boolean, val reason: Reason?)

    /**
     * @param permitted overlay grant (悬浮窗权限)
     * @param enabled setting "运行时显示悬浮窗"
     * @param always setting "后台一直显示" (also while no script runs)
     * @param running a script is running
     * @param appForeground one of our activities is on screen
     * @param scriptForce `ui.float_show()` = true / `ui.float_hide()` = false for the current run, null = not called
     */
    fun decide(
        permitted: Boolean,
        enabled: Boolean,
        always: Boolean,
        running: Boolean,
        appForeground: Boolean,
        scriptForce: Boolean? = null,
    ): Decision = when {
        !permitted -> Decision(false, Reason.NO_PERMISSION)
        scriptForce == true -> Decision(true, null)
        scriptForce == false -> Decision(false, Reason.SCRIPT_HIDDEN)
        !enabled -> Decision(false, Reason.DISABLED)
        appForeground -> Decision(false, Reason.FOREGROUND)
        running || always -> Decision(true, null)
        else -> Decision(false, Reason.IDLE)
    }

    // ---- panel state machine --------------------------------------------------------------

    data class State(val visible: Boolean = false, val expanded: Boolean = false)

    enum class Event { SHOW, HIDE, TAP, ACTION }

    /** SHOW/HIDE follow [decide]; TAP toggles the panel; ACTION (a panel button was used) collapses it. A hidden window is always collapsed. */
    fun next(s: State, e: Event): State = when (e) {
        Event.SHOW -> s.copy(visible = true)
        Event.HIDE -> State(visible = false, expanded = false)
        Event.TAP -> if (s.visible) s.copy(expanded = !s.expanded) else s
        Event.ACTION -> s.copy(expanded = false)
    }

    // ---- position ---------------------------------------------------------------------------

    /** Where the window rests: at the left or right screen edge, [yFrac] of the usable height down. */
    data class Dock(val right: Boolean, val yFrac: Float)

    val DEFAULT_DOCK = Dock(right = true, yFrac = 0.6f)

    fun clamp(v: Int, lo: Int, hi: Int): Int = if (hi < lo) lo else minOf(maxOf(v, lo), hi)

    /** Top-left y that keeps a window of height [h] fully on a screen of height [screenH]. */
    fun clampY(y: Int, h: Int, screenH: Int): Int = clamp(y, 0, screenH - h)

    /** Edge-snapping (AScript: 坐标为 0/-1 时自动缩边): the nearer screen edge for a window dropped at [x]. */
    fun snapRight(x: Int, w: Int, screenW: Int): Boolean = x + w / 2 >= screenW / 2

    fun dockX(right: Boolean, w: Int, screenW: Int): Int = if (right) maxOf(0, screenW - w) else 0

    /** The dock for a window dropped at (x, y). */
    fun dockFor(x: Int, y: Int, w: Int, h: Int, screenW: Int, screenH: Int): Dock {
        val span = maxOf(1, screenH - h)
        return Dock(snapRight(x, w, screenW), clampFrac(clampY(y, h, screenH).toFloat() / span))
    }

    /** Top-left (x, y) of the window for a stored [dock] on this screen. */
    fun place(dock: Dock, w: Int, h: Int, screenW: Int, screenH: Int): Pair<Int, Int> =
        dockX(dock.right, w, screenW) to clampY((clampFrac(dock.yFrac) * maxOf(0, screenH - h)).toInt(), h, screenH)

    /**
     * AScript `FloatWindow.show(x, y)` → a dock. -1 = far edge (right / bottom), 0 = near edge (left / top),
     * a decimal below 1 = share of the screen, 1 and up = pixels. XScript always rests on a side edge, so a
     * pixel or percentage x only chooses the nearer side. null keeps [current].
     */
    fun resolve(x: Float?, y: Float?, current: Dock, w: Int, h: Int, screenW: Int, screenH: Int): Dock {
        val right = when {
            x == null -> current.right
            x == -1f -> true
            x == 0f -> false
            x < 1f -> snapRight((x * screenW).toInt(), w, screenW)
            else -> snapRight(x.toInt(), w, screenW)
        }
        val span = maxOf(1, screenH - h)
        val frac = when {
            y == null -> current.yFrac
            y == -1f -> 1f
            y == 0f -> 0f
            y < 1f -> clampFrac(y * screenH / span)
            else -> clampFrac(clampY(y.toInt(), h, screenH).toFloat() / span)
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
}
