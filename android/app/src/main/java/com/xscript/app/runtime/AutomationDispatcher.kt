package com.xscript.app.runtime

import android.graphics.Bitmap
import android.os.SystemClock
import com.xscript.app.IAutomation
import com.xscript.app.XscriptApp
import com.xscript.app.a11y.AccessibilityEngine
import com.xscript.app.capture.CaptureEngine

/**
 * Routes automation calls: in the main process straight to [Automation], in the
 * :script process over the [IAutomation] binder to the main process.
 */
object AutomationDispatcher {
    @Volatile
    var remote: IAutomation? = null

    private val local: Boolean get() = XscriptApp.isMainProcess

    private fun rpc(): IAutomation? {
        remote?.let { return it }
        // Binding happens asynchronously right after the script process starts.
        val deadline = SystemClock.uptimeMillis() + 3000
        while (remote == null && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(20)
        return remote
    }

    fun dumpTree(mode: Int): String {
        if (local) return Automation.dumpTree(mode).toString()
        val pfd = rpc()?.dumpTree(mode) ?: return """{"mode":$mode,"roots":[],"error":"offline"}"""
        return String(Pipes.receive(pfd), Charsets.UTF_8)
    }

    fun click(x: Int, y: Int, durMs: Int): Boolean =
        if (local) Automation.click(x, y, durMs) else rpc()?.click(x, y, durMs) ?: false

    fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, durMs: Int): Boolean =
        if (local) Automation.swipe(x1, y1, x2, y2, durMs) else rpc()?.swipe(x1, y1, x2, y2, durMs) ?: false

    fun gesture(json: String): Boolean =
        if (local) Automation.gesture(json) else rpc()?.gesture(json) ?: false

    fun touch(action: Int, x: Int, y: Int, durMs: Int): Boolean =
        if (local) Automation.touch(action, x, y, durMs) else rpc()?.touch(action, x, y, durMs) ?: false

    fun nodeAction(path: String, action: String, arg: String): Boolean =
        if (local) Automation.nodeAction(path, action, arg) else rpc()?.nodeAction(path, action, arg) ?: false

    fun inputText(text: String): Boolean =
        if (local) Automation.inputText(text) else rpc()?.inputText(text) ?: false

    fun globalAction(name: String): Boolean =
        if (local) Automation.globalAction(name) else rpc()?.globalAction(name) ?: false

    fun isAccessibilityOn(): Boolean =
        if (local) AccessibilityEngine.isOn() else rpc()?.isAccessibilityOn ?: false

    fun captureToFile(path: String): String {
        if (local) return CaptureEngine.captureToFile(XscriptApp.instance, path).orEmpty()
        return rpc()?.captureToFile(path).orEmpty()
    }

    /** Raw frame (see [FrameCodec]) cropped to [l,t,r,b]; empty array when capture is unavailable. */
    fun captureRaw(l: Int, t: Int, r: Int, b: Int): ByteArray {
        if (local) {
            CaptureEngine.encodeFrame(l, t, r, b)?.let { return it }
            val full = CaptureEngine.captureBitmap() ?: return ByteArray(0)
            val cropped = FrameCodec.crop(full, l, t, r, b)
            val bytes = FrameCodec.encode(cropped)
            if (cropped !== full) cropped.recycle()
            full.recycle()
            return bytes
        }
        val pfd = rpc()?.captureFrame(l, t, r, b) ?: return ByteArray(0)
        return Pipes.receiveFrame(pfd)
    }

    fun captureBitmap(l: Int, t: Int, r: Int, b: Int): Bitmap? {
        if (local) {
            val full = CaptureEngine.captureBitmap() ?: return null
            val cropped = FrameCodec.crop(full, l, t, r, b)
            if (cropped !== full) full.recycle()
            return cropped
        }
        return FrameCodec.decode(captureRaw(l, t, r, b))
    }

    fun control(op: String, arg: String): String =
        if (local) MainControl.safeHandle(op, arg) else rpc()?.control(op, arg).orEmpty()
}
