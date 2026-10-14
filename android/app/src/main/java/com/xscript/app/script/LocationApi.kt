package com.xscript.app.script

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.Looper
import com.xscript.app.XscriptApp
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/** Process-local location subscriptions. Polls never retain unbounded location history. */
object LocationApi {
    private val lock = Any()
    private var events = LinkedBlockingQueue<JSONObject>(64)
    private val ctx: Context get() = XscriptApp.instance
    private val manager: LocationManager get() = ctx.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    private var listener: LocationListener? = null
    @Volatile private var generation = 0L

    fun call(op: String, a: JSONObject): String = try {
        when (op.removePrefix("location_")) {
            "request" -> synchronized(lock) {
                val minTime = a.optLong("min_time_updata", 5000)
                val minDistance = a.optDouble("min_distance_change", 0.0)
                require(minTime >= 0 && minDistance.isFinite() && minDistance >= 0 && minDistance <= Float.MAX_VALUE) {
                    "Location update time and distance must be finite and nonnegative"
                }
                val providers = providers()
                close()
                require(providers.isNotEmpty()) { "No enabled location provider is available" }
                val currentGeneration = generation
                val next = object : LocationListener {
                    override fun onLocationChanged(location: Location) {
                        synchronized(lock) {
                            if (generation != currentGeneration) return
                            val value = snapshot(location)
                            if (!events.offer(value)) {
                                events.poll()
                                events.offer(value)
                            }
                        }
                    }
                    override fun onProviderEnabled(provider: String) {}
                    override fun onProviderDisabled(provider: String) {}
                    @Deprecated("Android compatibility callback")
                    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
                }
                listener = next
                try {
                    for (provider in providers) {
                        manager.requestLocationUpdates(provider, minTime, minDistance.toFloat(), next, Looper.getMainLooper())
                    }
                } catch (e: Exception) {
                    close()
                    throw e
                }
                JSONObject().put("ok", true).put("providers", JSONArray(providers)).put("subscription", currentGeneration).toString()
            }
            "last" -> {
                val last = providers().mapNotNull { manager.getLastKnownLocation(it) }
                    .maxByOrNull { it.elapsedRealtimeNanos }
                last?.let { snapshot(it).toString() } ?: "null"
            }
            "poll" -> {
                val result = JSONArray()
                val token = a.optLong("subscription", generation)
                val queue = synchronized(lock) { if (token == generation) events else null }
                val first = queue?.poll(a.optLong("timeout_ms", 250).coerceIn(0, 500), TimeUnit.MILLISECONDS)
                synchronized(lock) {
                    if (token == generation) {
                        first?.let { result.put(it) }
                        while (result.length() < 64) result.put(queue?.poll() ?: break)
                    }
                }
                result.toString()
            }
            "close" -> { close(); "{\"ok\":true}" }
            else -> throw IllegalArgumentException("Unknown location operation $op")
        }
    } catch (e: SecurityException) {
        JSONObject().put("error", e.message ?: "Location permission denied").put("code", "permission_denied").toString()
    } catch (e: Exception) {
        JSONObject().put("error", e.message ?: e.javaClass.simpleName).toString()
    }

    private fun providers(): List<String> {
        val fine = ctx.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        val coarse = ctx.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
        if (!fine && !coarse) throw SecurityException("Location requires ACCESS_FINE_LOCATION or ACCESS_COARSE_LOCATION")
        val available = manager.allProviders.toSet()
        return listOfNotNull(
            LocationManager.GPS_PROVIDER.takeIf { fine && it in available && manager.isProviderEnabled(it) },
            LocationManager.NETWORK_PROVIDER.takeIf { it in available && manager.isProviderEnabled(it) },
        )
    }

    private fun snapshot(location: Location): JSONObject = JSONObject()
        .put("latitude", location.latitude).put("longitude", location.longitude)
        .put("altitude", location.altitude).put("accuracy", location.accuracy)
        .put("speed", location.speed).put("bearing", location.bearing)
        .put("time", location.time).put("provider", location.provider)

    fun close() = synchronized(lock) {
        generation++
        val previous = listener
        listener = null
        try {
            previous?.let { manager.removeUpdates(it) }
        } finally {
            events.clear()
            events = LinkedBlockingQueue(64)
        }
    }
}
