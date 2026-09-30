package com.xscript.app.a11y

import android.accessibilityservice.AccessibilityService
import android.view.KeyEvent
import android.view.accessibility.AccessibilityEvent
import com.xscript.app.events.EventHub

class XscriptAccessibilityService : AccessibilityService() {
    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        AccessibilityEngine.attach(this)
        // A script may already be listening for keys (service re-bound mid-run).
        EventHub.applyKeyFilter(EventHub.wantsKeys())
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return
        if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            AccessibilityEngine.onWindowChanged(event.packageName?.toString(), event.className?.toString())
        }
        EventHub.onAccessibilityEvent(event)
    }

    /** Only called while a script listens for keys (FLAG_REQUEST_FILTER_KEY_EVENTS). Never consumes. */
    override fun onKeyEvent(event: KeyEvent?): Boolean {
        if (event != null) EventHub.onKey(event)
        return false
    }

    override fun onInterrupt() = Unit

    override fun onDestroy() {
        if (instance === this) {
            instance = null
            AccessibilityEngine.detach()
        }
        super.onDestroy()
    }

    companion object {
        @Volatile
        var instance: XscriptAccessibilityService? = null
            private set

        fun isConnected(): Boolean = instance != null
    }
}
