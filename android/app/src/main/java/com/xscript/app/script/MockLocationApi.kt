package com.xscript.app.script

import android.app.AppOpsManager
import android.content.Context
import android.location.Location
import android.location.LocationManager
import android.location.provider.ProviderProperties
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import com.xscript.app.XscriptApp
import com.xscript.app.root.RootShell
import org.json.JSONObject

/** Validated `location.mock.start` arguments (WGS84; the Python side converts bd09/gcj02). Pure for the JVM tests. */
internal data class MockFix(val lat: Double, val lon: Double, val accuracy: Float, val intervalMs: Long) {
    companion object {
        const val MIN_INTERVAL = 100L
        const val MAX_INTERVAL = 60_000L

        fun from(a: JSONObject): MockFix {
            val lat = a.optDouble("lat", Double.NaN)
            val lon = a.optDouble("lon", Double.NaN)
            require(lat.isFinite() && lat in -90.0..90.0) { "latitude must be within -90..90" }
            require(lon.isFinite() && lon in -180.0..180.0) { "longitude must be within -180..180" }
            val acc = a.optDouble("accuracy", 5.0)
            require(acc.isFinite() && acc > 0 && acc <= 10_000) { "accuracy must be within (0, 10000] metres" }
            val iv = a.optLong("interval", 1000)
            require(iv > 0) { "interval must be positive" }
            return MockFix(lat, lon, acc.toFloat(), iv.coerceIn(MIN_INTERVAL, MAX_INTERVAL))
        }
    }
}

/**
 * `location.mock`: system-wide mock location through LocationManager test providers (gps + network). Android only allows
 * this for the app chosen under 开发者选项 → 选择模拟位置信息应用; with root the app op is granted automatically.
 * Mocking stops on mock.stop() and when the script ends (the providers are removed so real locations come back).
 */
object MockLocationApi {
    private val ctx: Context get() = XscriptApp.instance
    private val manager: LocationManager get() = ctx.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    private val providers = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    private var fix: MockFix? = null
    private var active = emptyList<String>()
    private var pushes = 0L

    fun call(op: String, a: JSONObject): String = synchronized(this) {
        try {
            when (op) {
                "location_mock_start" -> start(MockFix.from(a)).toString()
                "location_mock_stop" -> { stop(); JSONObject().put("ok", true).toString() }
                "location_mock_status" -> status().toString()
                else -> throw IllegalArgumentException("unknown mock location op $op")
            }
        } catch (e: SecurityException) {
            JSONObject().put("error", notAllowedMessage()).put("code", "not_mock_app").toString()
        } catch (e: IllegalArgumentException) {
            JSONObject().put("error", e.message ?: "bad arguments").put("code", "bad_args").toString()
        }
    }

    private fun notAllowedMessage() =
        "XScript is not the mock location app: enable 开发者选项 → 选择模拟位置信息应用 → ${ctx.packageName} (or grant root)"

    private fun allowed(): Boolean {
        val ops = ctx.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
        val mode = try {
            @Suppress("DEPRECATION")
            if (Build.VERSION.SDK_INT >= 29) ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_MOCK_LOCATION, android.os.Process.myUid(), ctx.packageName)
            else ops.checkOpNoThrow(AppOpsManager.OPSTR_MOCK_LOCATION, android.os.Process.myUid(), ctx.packageName)
        } catch (_: Exception) {
            AppOpsManager.MODE_ERRORED
        }
        return mode == AppOpsManager.MODE_ALLOWED
    }

    private fun ensureAllowed() {
        if (allowed()) return
        if (RootShell.known() == true) RootShell.exec("appops set " + RootShell.quote(ctx.packageName) + " android:mock_location allow")
        if (!allowed()) throw SecurityException(notAllowedMessage())
    }

    private fun start(f: MockFix): JSONObject {
        ensureAllowed()
        if (fix == null) {
            val added = mutableListOf<String>()
            for (p in providers) {
                try { manager.removeTestProvider(p) } catch (_: Exception) {}
                addProvider(p)
                manager.setTestProviderEnabled(p, true)
                added += p
            }
            active = added
            thread = HandlerThread("xscript-mock-location").also { it.start() }
            handler = Handler(thread!!.looper)
        }
        fix = f
        handler?.removeCallbacksAndMessages(null)
        val tick = object : Runnable {
            override fun run() {
                val cur = synchronized(this@MockLocationApi) { fix } ?: return
                push(cur)
                handler?.postDelayed(this, cur.intervalMs)
            }
        }
        handler?.post(tick)
        return status().put("ok", true)
    }

    private fun addProvider(p: String) {
        val gps = p == LocationManager.GPS_PROVIDER
        // the ProviderProperties constants are compile-time ints (same values as the old Criteria ones), fine below API 31
        @Suppress("InlinedApi")
        manager.addTestProvider(p, false, false, false, false, true, true, gps,
            ProviderProperties.POWER_USAGE_LOW, ProviderProperties.ACCURACY_FINE)
    }

    private fun push(f: MockFix) {
        for (p in active) {
            val loc = Location(p).apply {
                latitude = f.lat
                longitude = f.lon
                accuracy = f.accuracy
                altitude = 0.0
                time = System.currentTimeMillis()
                elapsedRealtimeNanos = SystemClock.elapsedRealtimeNanos()
            }
            try {
                manager.setTestProviderLocation(p, loc)
                synchronized(this) { pushes++ }
            } catch (_: Exception) {
                // the user revoked the mock-location app mid-run: status() reports it
            }
        }
    }

    private fun status(): JSONObject {
        val f = fix
        val out = JSONObject().put("running", f != null).put("allowed", allowed()).put("providers", org.json.JSONArray(active)).put("updates", pushes)
        if (f != null) out.put("lat", f.lat).put("lon", f.lon).put("accuracy", f.accuracy.toDouble()).put("interval", f.intervalMs)
        return out
    }

    fun stop() = synchronized(this) {
        fix = null
        handler?.removeCallbacksAndMessages(null)
        thread?.quitSafely()
        thread = null
        handler = null
        for (p in active) {
            try { manager.setTestProviderEnabled(p, false) } catch (_: Exception) {}
            try { manager.removeTestProvider(p) } catch (_: Exception) {}
        }
        active = emptyList()
        pushes = 0
    }
}
