package com.xscript.app.permission

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock

/** Not exported: only this app can launch a permission request. Android presents the grant UI. */
class PermissionActivity : Activity() {
    private var completed = false
    private val handler = Handler(Looper.getMainLooper())
    private val timeout = Runnable { complete(PermissionKeys.TIMEOUT) }
    private var deadline = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val key = intent.getStringExtra("key").orEmpty()
        val reply = intent.getStringExtra("reply").orEmpty()
        if (key.isEmpty() || !reply.startsWith(packageName + ".PERMISSION_RESULT.")) {
            completed = true
            finish()
            return
        }
        deadline = savedInstanceState?.getLong("deadline")
            ?: (SystemClock.elapsedRealtime() + intent.getLongExtra("timeout_ms", 60_000).coerceIn(1, 600_000))
        handler.postDelayed(timeout, (deadline - SystemClock.elapsedRealtime()).coerceAtLeast(0))
        if (savedInstanceState == null) {
            if (PermissionApi.has(key)) complete(PermissionKeys.GRANTED)
            else requestPermissions(PermissionKeys.runtimeBatch(key), 1)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != 1) return
        val key = intent.getStringExtra("key").orEmpty()
        val granted = grantResults.isNotEmpty() && PermissionApi.has(key)
        complete(if (granted) PermissionKeys.GRANTED else PermissionKeys.DENIED)
    }

    private fun complete(code: Int) {
        if (completed) return
        completed = true
        val reply = intent.getStringExtra("reply") ?: return finish()
        sendBroadcast(Intent(reply).setPackage(packageName).putExtra("result", code))
        finish()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putLong("deadline", deadline)
        super.onSaveInstanceState(outState)
    }

    override fun onDestroy() {
        handler.removeCallbacks(timeout)
        if (!completed && !isChangingConfigurations) complete(PermissionKeys.DENIED)
        super.onDestroy()
    }
}
