package com.xscript.app.util

import android.content.Context
import android.graphics.Point
import android.hardware.display.DisplayManager
import android.view.Display

/**
 * The whole screen in pixels, in the current rotation, system bars included: the space screenshots, taps and node
 * bounds use. `resources.displayMetrics` leaves the navigation bar out (1080x2209 on a 1080x2400 emulator), so a
 * script that clicked near the bottom with its numbers missed.
 */
object DisplaySize {
    fun real(ctx: Context): Point {
        val p = Point()
        val d = ctx.getSystemService(DisplayManager::class.java)?.getDisplay(Display.DEFAULT_DISPLAY)
        if (d != null) {
            @Suppress("DEPRECATION")
            d.getRealSize(p)
        }
        if (p.x <= 0 || p.y <= 0) {
            val m = ctx.resources.displayMetrics
            p.set(m.widthPixels, m.heightPixels)
        }
        return p
    }
}
