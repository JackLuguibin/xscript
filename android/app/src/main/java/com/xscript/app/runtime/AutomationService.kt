package com.xscript.app.runtime

import android.app.Service
import android.content.Intent
import android.os.IBinder
import android.os.ParcelFileDescriptor
import android.util.Log
import com.xscript.app.IAutomation
import com.xscript.app.IEventSink
import com.xscript.app.a11y.AccessibilityEngine
import com.xscript.app.capture.CaptureEngine
import com.xscript.app.ui.FloatControl

/**
 * Binder that the :script process uses to reach main-process automation state.
 *
 * Every method swallows exceptions and returns an "empty" result so a failing
 * backend (missing permission, dead service) surfaces as a falsy value in
 * Python instead of a remote exception that kills the script.
 */
class AutomationService : Service() {
    private inline fun <T> safe(name: String, fallback: T, block: () -> T): T =
        try {
            block()
        } catch (t: Throwable) {
            Log.w(TAG, "$name failed", t)
            fallback
        }

    private val binder = object : IAutomation.Stub() {
        override fun dumpTree(mode: Int): ParcelFileDescriptor {
            val bytes = safe("dumpTree", ByteArray(0)) {
                Automation.dumpTree(mode).toString().toByteArray(Charsets.UTF_8)
            }
            return Pipes.send(bytes)
        }

        override fun click(x: Int, y: Int, durMs: Int): Boolean =
            safe("click", false) { Automation.click(x, y, durMs) }

        override fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, durMs: Int): Boolean =
            safe("swipe", false) { Automation.swipe(x1, y1, x2, y2, durMs) }

        override fun gesture(strokesJson: String): Boolean =
            safe("gesture", false) { Automation.gesture(strokesJson) }

        override fun touch(action: Int, x: Int, y: Int, durMs: Int): Boolean =
            safe("touch", false) { Automation.touch(action, x, y, durMs) }

        override fun nodeAction(path: String, action: String, arg: String): Boolean =
            safe("nodeAction", false) { Automation.nodeAction(path, action, arg) }

        override fun inputText(text: String): Boolean =
            safe("inputText", false) { Automation.inputText(text) }

        override fun globalAction(name: String): Boolean =
            safe("globalAction", false) { Automation.globalAction(name) }

        override fun isAccessibilityOn(): Boolean = AccessibilityEngine.isOn()

        override fun captureToFile(path: String): String =
            safe("captureToFile", "") {
                CaptureEngine.captureToFile(this@AutomationService, path).orEmpty()
            }

        override fun captureFrame(left: Int, top: Int, right: Int, bottom: Int): ParcelFileDescriptor {
            val bytes = safe("captureFrame", ByteArray(0)) {
                val full = CaptureEngine.captureBitmap() ?: return@safe ByteArray(0)
                val cropped = FrameCodec.crop(full, left, top, right, bottom)
                val encoded = FrameCodec.encode(cropped)
                if (cropped !== full) cropped.recycle()
                full.recycle()
                encoded
            }
            return Pipes.send(bytes)
        }

        override fun control(op: String, arg: String): String = MainControl.safeHandle(op, arg)

        override fun attachScript(project: String, sink: IEventSink) {
            safe("attachScript", Unit) { ScriptSupervisor.attach(project, sink) }
        }
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        FloatControl.hide()
        super.onDestroy()
    }

    private companion object {
        const val TAG = "XScriptAutomation"
    }
}
