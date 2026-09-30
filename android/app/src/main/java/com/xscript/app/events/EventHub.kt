package com.xscript.app.events

import android.accessibilityservice.AccessibilityServiceInfo
import android.app.Notification
import android.app.PendingIntent
import android.graphics.Rect
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.service.notification.StatusBarNotification
import android.util.Log
import android.view.KeyEvent
import android.view.accessibility.AccessibilityEvent
import com.xscript.app.IEventSink
import com.xscript.app.a11y.XscriptAccessibilityService
import com.xscript.app.a11y.recycleCompat
import org.json.JSONArray
import org.json.JSONObject

/**
 * Main-process event fan-out to the running script (one script runs at a time).
 *
 * Sources: accessibility key filtering (`key`), view click / long-click / scroll events
 * (`touch`), notifications from the notification listener or, without that grant, from
 * accessibility (`notification`), toasts (`toast`) and raw accessibility events (`a11y`).
 * Only subscribed types are serialised and sent, and delivery is a oneway binder call, so
 * an idle subscription costs nothing and a slow script never blocks the accessibility thread.
 */
object EventHub {
    const val KEY = "key"
    const val TOUCH = "touch"
    const val NOTIFICATION = "notification"
    const val TOAST = "toast"
    const val A11Y = "a11y"
    const val CLOUD = "cloud"

    /** Default raw accessibility mask: everything except the very chatty content changes. */
    private const val DEFAULT_A11Y_MASK = AccessibilityEvent.TYPES_ALL_MASK and
        AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED.inv()

    private val main = Handler(Looper.getMainLooper())

    @Volatile private var sink: IEventSink? = null
    @Volatile private var types: Set<String> = emptySet()
    @Volatile private var a11yMask: Int = DEFAULT_A11Y_MASK

    @Volatile var listenerConnected = false

    /** contentIntent of recent notifications, so `event.send()` can open them later. */
    private val intents = object : LinkedHashMap<String, PendingIntent>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, PendingIntent>?) = size > 64
    }

    fun attach(s: IEventSink) {
        sink = s
        subscribe(emptySet(), DEFAULT_A11Y_MASK)
    }

    fun detach(s: IEventSink) {
        if (sink?.asBinder() == s.asBinder()) {
            sink = null
            subscribe(emptySet(), DEFAULT_A11Y_MASK)
        }
    }

    fun subscribe(newTypes: Set<String>, mask: Int) {
        types = newTypes
        a11yMask = if (mask == 0) DEFAULT_A11Y_MASK else mask
        main.post { applyKeyFilter(KEY in types) }
    }

    fun wantsKeys(): Boolean = KEY in types

    fun subscribed(): JSONObject = JSONObject()
        .put("types", JSONArray(types.toList()))
        .put("attached", sink != null)
        .put("notification_listener", listenerConnected)

    /** Key filtering is switched on only while a script listens: it adds latency to every key. */
    fun applyKeyFilter(on: Boolean) {
        val svc = XscriptAccessibilityService.instance ?: return
        try {
            val info = svc.serviceInfo ?: return
            val flag = AccessibilityServiceInfo.FLAG_REQUEST_FILTER_KEY_EVENTS
            val want = if (on) info.flags or flag else info.flags and flag.inv()
            if (want != info.flags) {
                info.flags = want
                svc.serviceInfo = info
            }
        } catch (t: Throwable) {
            Log.w(TAG, "key filter", t)
        }
    }

    private fun emit(type: String, payload: JSONObject) {
        val s = sink ?: return
        if (type !in types) return
        payload.put("type", type)
        if (!payload.has("time")) payload.put("time", System.currentTimeMillis())
        try {
            s.onEvent(payload.toString())
        } catch (t: Throwable) {
            Log.w(TAG, "deliver $type", t)
        }
    }

    // ------------------------------------------------------------------ sources

    /** A 云控 message for the script (`cloud.on_message`, AScript `system.channel`). */
    fun cloudMessage(data: Any) {
        emit(CLOUD, JSONObject().put("data", data))
    }

    fun onKey(event: KeyEvent) {
        if (KEY !in types) return
        val action = when (event.action) {
            KeyEvent.ACTION_DOWN -> "down"
            KeyEvent.ACTION_UP -> "up"
            else -> return
        }
        emit(
            KEY,
            JSONObject()
                .put("key_code", event.keyCode)
                .put("action", action)
                .put("repeat", event.repeatCount)
                .put("long_press", event.isLongPress),
        )
    }

    fun onAccessibilityEvent(event: AccessibilityEvent) {
        val current = types
        if (current.isEmpty()) return
        val t = event.eventType
        if (TOUCH in current) touch(event)
        if (t == AccessibilityEvent.TYPE_NOTIFICATION_STATE_CHANGED) {
            val data = event.parcelableData
            if (data is Notification) {
                if (NOTIFICATION in current && !listenerConnected) notificationFromA11y(event, data)
            } else if (TOAST in current) {
                emit(
                    TOAST,
                    JSONObject()
                        .put("package", event.packageName?.toString().orEmpty())
                        .put("text", joinText(event)),
                )
            }
        }
        if (A11Y in current && (t and a11yMask) != 0) emit(A11Y, describe(event))
    }

    private fun touch(event: AccessibilityEvent) {
        val action = when (event.eventType) {
            AccessibilityEvent.TYPE_VIEW_CLICKED -> "click"
            AccessibilityEvent.TYPE_VIEW_LONG_CLICKED -> "long_click"
            AccessibilityEvent.TYPE_VIEW_SCROLLED -> "scroll"
            else -> return
        }
        val rect = Rect()
        val source = try {
            event.source
        } catch (_: Throwable) {
            null
        }
        if (source != null) {
            source.getBoundsInScreen(rect)
            source.recycleCompat()
        }
        emit(
            TOUCH,
            JSONObject()
                .put("action", action)
                .put("x", rect.exactCenterX().toDouble())
                .put("y", rect.exactCenterY().toDouble())
                .put("rect", JSONArray(listOf(rect.left, rect.top, rect.right, rect.bottom)))
                .put("package", event.packageName?.toString().orEmpty())
                .put("class", event.className?.toString().orEmpty())
                .put("text", joinText(event)),
        )
    }

    private fun notificationFromA11y(event: AccessibilityEvent, n: Notification) {
        val pkg = event.packageName?.toString().orEmpty()
        val key = "a11y|$pkg|${event.eventTime}"
        val payload = notificationPayload(pkg, key, n, 0, null)
        if (payload.optString("text").isEmpty()) payload.put("text", joinText(event))
        payload.put("source", "accessibility")
        emit(NOTIFICATION, payload)
    }

    /** From [XscriptNotificationListener]. */
    fun onNotificationPosted(sbn: StatusBarNotification) {
        if (NOTIFICATION !in types) return
        val payload = notificationPayload(sbn.packageName, sbn.key, sbn.notification, sbn.id, sbn.tag)
            .put("time", sbn.postTime)
            .put("ongoing", sbn.isOngoing)
            .put("clearable", sbn.isClearable)
            .put("source", "listener")
        emit(NOTIFICATION, payload)
    }

    private fun notificationPayload(pkg: String, key: String, n: Notification, id: Int, tag: String?): JSONObject {
        val extras = n.extras
        fun ex(name: String) = extras?.getCharSequence(name)?.toString().orEmpty()
        n.contentIntent?.let { synchronized(intents) { intents[key] = it } }
        return JSONObject()
            .put("package", pkg)
            .put("key", key)
            .put("id", id)
            .put("tag", tag ?: JSONObject.NULL)
            .put("title", ex(Notification.EXTRA_TITLE))
            .put("text", ex(Notification.EXTRA_TEXT))
            .put("sub_text", ex(Notification.EXTRA_SUB_TEXT))
            .put("big_text", ex(Notification.EXTRA_BIG_TEXT))
            .put("ticker", n.tickerText?.toString().orEmpty())
            .put("category", n.category ?: "")
            .put("can_send", n.contentIntent != null)
    }

    /** Fire the notification's contentIntent (AScript `event.send()`). */
    fun sendNotification(key: String): Boolean {
        val pi = synchronized(intents) { intents[key] } ?: return false
        return try {
            if (Build.VERSION.SDK_INT >= 34) {
                val opts = android.app.ActivityOptions.makeBasic()
                    .setPendingIntentBackgroundActivityStartMode(android.app.ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED)
                pi.send(null, 0, null, null, null, null, opts.toBundle())
            } else {
                pi.send()
            }
            true
        } catch (t: Throwable) {
            Log.w(TAG, "send notification", t)
            false
        }
    }

    private fun describe(event: AccessibilityEvent): JSONObject = JSONObject()
        .put("event_type", event.eventType)
        .put("event_name", AccessibilityEvent.eventTypeToString(event.eventType))
        .put("package", event.packageName?.toString().orEmpty())
        .put("class", event.className?.toString().orEmpty())
        .put("text", JSONArray(event.text.map { it?.toString().orEmpty() }))
        .put("desc", event.contentDescription?.toString().orEmpty())
        .put("event_time", event.eventTime)
        .put("content_change_types", event.contentChangeTypes)

    private fun joinText(event: AccessibilityEvent): String =
        event.text.joinToString(" ") { it?.toString().orEmpty() }.trim()

    private const val TAG = "XScriptEvents"
}
