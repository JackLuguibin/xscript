package com.xscript.app.script

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Handler
import android.os.HandlerThread
import com.xscript.app.XscriptApp
import org.json.JSONArray
import org.json.JSONObject
import java.util.ArrayDeque

/** Native queues are scoped by registration token so cancelled pollers cannot drain a new run. */
object SensorsApi {
    private val lock = Any()
    private val registrations = HashMap<Int, Registration>()
    private var thread: HandlerThread? = null
    private val manager: SensorManager
        get() = XscriptApp.instance.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val supported = setOf(Sensor.TYPE_ACCELEROMETER, Sensor.TYPE_GYROSCOPE, Sensor.TYPE_LIGHT, Sensor.TYPE_PROXIMITY)

    private class Registration(val token: String) : SensorEventListener {
        val queue = ArrayDeque<JSONObject>()
        override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
        override fun onSensorChanged(event: SensorEvent) {
            synchronized(lock) {
                if (registrations[event.sensor.type] !== this) return
                val values = event.values
                val row = JSONObject()
                    .put("x", values.getOrElse(0) { 0f }.toDouble())
                    .put("y", values.getOrElse(1) { 0f }.toDouble())
                    .put("z", values.getOrElse(2) { 0f }.toDouble())
                    .put("timestamp", event.timestamp).put("accuracy", event.accuracy)
                if (queue.size >= 256) queue.removeFirst()
                queue.addLast(row)
            }
        }
    }

    fun call(op: String, a: JSONObject): String = synchronized(lock) {
        val type = a.getInt("type")
        require(type in supported) { "unsupported sensor type $type" }
        val token = a.getString("token")
        require(token.isNotEmpty()) { "sensor token must not be empty" }
        when (op) {
            "sensor_register" -> {
                val delay = a.optInt("delay", SensorManager.SENSOR_DELAY_NORMAL)
                require(delay >= 0) { "sensor delay must be nonnegative" }
                val sensor = manager.getDefaultSensor(type)
                if (sensor == null) return@synchronized "false"
                registrations.remove(type)?.let { manager.unregisterListener(it); it.queue.clear() }
                val worker = thread ?: HandlerThread("xscript-sensors").also { it.start(); thread = it }
                val registration = Registration(token)
                registrations[type] = registration
                val ok = try {
                    manager.registerListener(registration, sensor, delay, Handler(worker.looper))
                } catch (e: Exception) {
                    registrations.remove(type)
                    manager.unregisterListener(registration)
                    if (registrations.isEmpty()) { thread?.quitSafely(); thread = null }
                    throw e
                }
                if (!ok) {
                    registrations.remove(type)
                    manager.unregisterListener(registration)
                    if (registrations.isEmpty()) { thread?.quitSafely(); thread = null }
                }
                ok.toString()
            }
            "sensor_poll" -> {
                val out = JSONArray()
                registrations[type]?.takeIf { it.token == token }?.let { r ->
                    while (r.queue.isNotEmpty()) out.put(r.queue.removeFirst())
                }
                out.toString()
            }
            "sensor_unregister" -> {
                val r = registrations[type]?.takeIf { it.token == token }
                if (r != null) {
                    registrations.remove(type)
                    manager.unregisterListener(r)
                    r.queue.clear()
                    if (registrations.isEmpty()) { thread?.quitSafely(); thread = null }
                }
                (r != null).toString()
            }
            else -> throw IllegalArgumentException("unknown sensor op $op")
        }
    }

    fun closeAll() = synchronized(lock) {
        registrations.values.forEach { manager.unregisterListener(it); it.queue.clear() }
        registrations.clear()
        thread?.quitSafely()
        thread = null
    }
}
