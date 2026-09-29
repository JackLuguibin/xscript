package com.xscript.app.a11y

import android.accessibilityservice.AccessibilityService
import android.view.accessibility.AccessibilityEvent

class XscriptAccessibilityService : AccessibilityService() {
    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        AccessibilityEngine.attach(this)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event?.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            AccessibilityEngine.onWindowChanged(event.packageName?.toString(), event.className?.toString())
        }
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
