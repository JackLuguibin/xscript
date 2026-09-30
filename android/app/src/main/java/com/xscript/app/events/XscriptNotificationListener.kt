package com.xscript.app.events

import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/** 通知使用权 grant: full notification data (title, text, id, contentIntent) for scripts. */
class XscriptNotificationListener : NotificationListenerService() {
    override fun onListenerConnected() {
        super.onListenerConnected()
        EventHub.listenerConnected = true
    }

    override fun onListenerDisconnected() {
        EventHub.listenerConnected = false
        super.onListenerDisconnected()
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        if (sbn != null) EventHub.onNotificationPosted(sbn)
    }
}
