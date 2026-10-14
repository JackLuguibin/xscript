package com.xscript.app.permission

/** Source-level AScript compatibility. Permission grants are always decided by Android. */
object PermissionKeys {
    const val GRANTED = 1
    const val DENIED = 0
    const val TIMEOUT = -1
    const val UNSUPPORTED = -2

    val settings = setOf("accessibility", "notification_listener", "usage_stats", "overlay", "write_settings", "manage_storage", "install_packages")
    private val aliases = mapOf(
        "camera" to "android.permission.CAMERA",
        "microphone" to "android.permission.RECORD_AUDIO",
        "record_audio" to "android.permission.RECORD_AUDIO",
        "sms" to "android.permission.READ_SMS",
        "phone" to "android.permission.READ_PHONE_STATE",
        "location" to "android.permission.ACCESS_FINE_LOCATION",
        "notification" to "android.permission.POST_NOTIFICATIONS",
        "bluetooth" to "android.permission.BLUETOOTH_CONNECT",
        "contacts" to "android.permission.READ_CONTACTS",
        "storage" to "android.permission.READ_EXTERNAL_STORAGE",
        "accessibility_service" to "accessibility",
        "system_alert_window" to "overlay",
        "android.permission.SYSTEM_ALERT_WINDOW" to "overlay",
        "android.permission.WRITE_SETTINGS" to "write_settings",
        "manage_external_storage" to "manage_storage",
        "android.permission.MANAGE_EXTERNAL_STORAGE" to "manage_storage",
        "android.permission.REQUEST_INSTALL_PACKAGES" to "install_packages",
    )

    fun normalize(key: String): String = aliases[key.trim()] ?: key.trim()

    fun runtimeBatch(key: String): Array<String> = if (key == "android.permission.ACCESS_FINE_LOCATION") {
        arrayOf("android.permission.ACCESS_COARSE_LOCATION", key)
    } else arrayOf(key)
}
