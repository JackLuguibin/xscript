package com.xscript.app.script

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothSocket
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import com.xscript.app.XscriptApp
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * `ascript.android.bluetooth`: scan (classic discovery or BLE), classic RFCOMM/SPP sockets and BLE GATT read/write/notify.
 * Payloads cross the bridge as base64. Runtime permissions (BLUETOOTH_SCAN/CONNECT on 12+, location for scans before 12)
 * are requested by the Python side; a missing grant comes back as code "permission_denied".
 */
@SuppressLint("MissingPermission") // every entry point catches SecurityException
object BluetoothApi {
    private val ctx: Context get() = XscriptApp.instance
    private val adapter: BluetoothAdapter? get() = (ctx.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager?)?.adapter
    private val ids = AtomicInteger()
    private val sockets = ConcurrentHashMap<String, BluetoothSocket>()
    private val gatts = ConcurrentHashMap<String, Gatt>()
    private const val CCCD = "00002902-0000-1000-8000-00805f9b34fb"

    fun call(op: String, a: JSONObject): String = try {
        when (op) {
            "bt_state" -> state().toString()
            "bt_enable" -> enable().toString()
            "bt_bonded" -> JSONArray(need().bondedDevices.map { dev(it, null) }).toString()
            "bt_scan" -> scan(a.optLong("timeout_ms", 10_000).coerceIn(500, 60_000), a.optBoolean("ble")).toString()
            "bt_connect" -> connect(BtCodec.address(a.getString("address")), BtCodec.uuid(a.optString("uuid", ""))).toString()
            "bt_write" -> { sock(a).outputStream.apply { write(BtCodec.decode(a.getString("data"))); flush() }; "{\"ok\":true}" }
            "bt_read" -> read(sock(a), a.optInt("max", 1024).coerceIn(1, 65536), a.optLong("timeout_ms", 1000)).toString()
            "bt_close" -> { close(a.getString("id")); "{\"ok\":true}" }
            "ble_connect" -> bleConnect(BtCodec.address(a.getString("address")), a.optLong("timeout_ms", 15_000)).toString()
            "ble_read" -> gatt(a).read(BtCodec.uuid(a.getString("service")), BtCodec.uuid(a.getString("char"))).toString()
            "ble_write" -> gatt(a).write(BtCodec.uuid(a.getString("service")), BtCodec.uuid(a.getString("char")),
                BtCodec.decode(a.getString("data")), a.optBoolean("no_response")).toString()
            "ble_notify" -> gatt(a).notify(BtCodec.uuid(a.getString("service")), BtCodec.uuid(a.getString("char")), a.optBoolean("enable", true)).toString()
            "ble_poll" -> gatt(a).poll(a.optLong("timeout_ms", 250).coerceIn(0, 5000)).toString()
            else -> throw IllegalArgumentException("unknown bluetooth op $op")
        }
    } catch (e: SecurityException) {
        err("permission_denied", e.message ?: "bluetooth permission required")
    } catch (e: IllegalArgumentException) {
        err("bad_args", e.message ?: "bad arguments")
    } catch (e: Exception) {
        err("failed", e.message ?: e.javaClass.simpleName)
    }

    private fun err(code: String, msg: String) = JSONObject().put("error", msg).put("code", code).toString()

    private fun need(): BluetoothAdapter {
        val ad = adapter ?: throw IllegalStateException("this device has no bluetooth")
        if (!ad.isEnabled) throw IllegalStateException("bluetooth is off (bluetooth.enable() asks the user to turn it on)")
        return ad
    }

    private fun state(): JSONObject {
        val ad = adapter
        return JSONObject().put("supported", ad != null).put("enabled", ad?.isEnabled == true)
            .put("ble", ctx.packageManager.hasSystemFeature("android.hardware.bluetooth_le"))
    }

    private fun enable(): Boolean {
        if (adapter?.isEnabled == true) return true
        ctx.startActivity(Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        return false
    }

    private fun dev(d: BluetoothDevice, rssi: Int?): JSONObject = JSONObject().put("name", d.name ?: "").put("address", d.address)
        .put("type", when (d.type) { BluetoothDevice.DEVICE_TYPE_LE -> "ble"; BluetoothDevice.DEVICE_TYPE_DUAL -> "dual"; BluetoothDevice.DEVICE_TYPE_CLASSIC -> "classic"; else -> "unknown" })
        .put("bonded", d.bondState == BluetoothDevice.BOND_BONDED).apply { if (rssi != null) put("rssi", rssi) }

    private fun scan(timeoutMs: Long, ble: Boolean): JSONArray {
        val ad = need()
        val found = LinkedHashMap<String, JSONObject>()
        if (ble) {
            val scanner = ad.bluetoothLeScanner ?: throw IllegalStateException("BLE scanning is unavailable")
            val cb = object : ScanCallback() {
                override fun onScanResult(type: Int, r: ScanResult) {
                    synchronized(found) { found[r.device.address] = dev(r.device, r.rssi) }
                }
            }
            scanner.startScan(cb)
            try { Thread.sleep(timeoutMs) } finally { scanner.stopScan(cb) }
        } else {
            val done = CountDownLatch(1)
            val rx = object : BroadcastReceiver() {
                override fun onReceive(c: Context, i: Intent) {
                    when (i.action) {
                        BluetoothDevice.ACTION_FOUND -> {
                            @Suppress("DEPRECATION")
                            val d = (if (Build.VERSION.SDK_INT >= 33) i.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
                            else i.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)) ?: return
                            val rssi = i.getShortExtra(BluetoothDevice.EXTRA_RSSI, Short.MIN_VALUE).toInt().takeIf { it != Short.MIN_VALUE.toInt() }
                            synchronized(found) { found[d.address] = dev(d, rssi) }
                        }
                        BluetoothAdapter.ACTION_DISCOVERY_FINISHED -> done.countDown()
                    }
                }
            }
            val filter = IntentFilter(BluetoothDevice.ACTION_FOUND).apply { addAction(BluetoothAdapter.ACTION_DISCOVERY_FINISHED) }
            if (Build.VERSION.SDK_INT >= 33) ctx.registerReceiver(rx, filter, Context.RECEIVER_EXPORTED) else ctx.registerReceiver(rx, filter)
            try {
                if (ad.isDiscovering) ad.cancelDiscovery()
                if (!ad.startDiscovery()) throw IllegalStateException("could not start discovery (location services off?)")
                done.await(timeoutMs, TimeUnit.MILLISECONDS)
            } finally {
                ad.cancelDiscovery()
                ctx.unregisterReceiver(rx)
            }
        }
        return synchronized(found) { JSONArray(found.values.toList()) }
    }

    // ---- classic RFCOMM ----------------------------------------------------------------------------------------------------------

    private fun connect(address: String, uuid: UUID): JSONObject {
        val ad = need()
        ad.cancelDiscovery() // discovery slows connections down a lot
        val d = ad.getRemoteDevice(address)
        val s = d.createRfcommSocketToServiceRecord(uuid)
        try { s.connect() } catch (e: java.io.IOException) {
            try { s.close() } catch (_: Exception) {}
            throw IllegalStateException("connect failed: ${e.message}")
        }
        val id = "c" + ids.incrementAndGet()
        sockets[id] = s
        return JSONObject().put("id", id).put("address", address)
    }

    private fun sock(a: JSONObject) = sockets[a.getString("id")] ?: throw IllegalStateException("connection is closed")

    private fun read(s: BluetoothSocket, max: Int, timeoutMs: Long): JSONObject {
        val inp = s.inputStream
        val end = System.currentTimeMillis() + timeoutMs.coerceIn(0, 60_000)
        while (inp.available() == 0 && System.currentTimeMillis() < end) Thread.sleep(10)
        val n = inp.available().coerceAtMost(max)
        val buf = ByteArray(n)
        val got = if (n > 0) inp.read(buf, 0, n) else 0
        return JSONObject().put("data", BtCodec.encode(buf.copyOf(maxOf(got, 0))))
    }

    // ---- BLE GATT ------------------------------------------------------------------------------------------------------------------

    private class Gatt(val id: String) : BluetoothGattCallback() {
        lateinit var g: BluetoothGatt
        val ready = CountDownLatch(1)
        @Volatile var connected = false
        @Volatile var failure: String? = null
        private var op: CountDownLatch? = null
        private var opValue: ByteArray? = null
        private var opStatus = 0
        val notes = LinkedBlockingQueue<JSONObject>(256)

        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                connected = true
                gatt.discoverServices()
            } else {
                connected = false
                failure = "disconnected (status $status)"
                ready.countDown()
                op?.countDown()
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS) failure = "service discovery failed ($status)"
            ready.countDown()
        }

        @Deprecated("pre-33 callback")
        override fun onCharacteristicRead(gatt: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) {
            @Suppress("DEPRECATION") finish(c.value, status)
        }

        override fun onCharacteristicRead(gatt: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray, status: Int) = finish(value, status)
        override fun onCharacteristicWrite(gatt: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) = finish(null, status)
        override fun onDescriptorWrite(gatt: BluetoothGatt, d: BluetoothGattDescriptor, status: Int) = finish(null, status)

        @Deprecated("pre-33 callback")
        override fun onCharacteristicChanged(gatt: BluetoothGatt, c: BluetoothGattCharacteristic) {
            @Suppress("DEPRECATION") note(c, c.value)
        }

        override fun onCharacteristicChanged(gatt: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray) = note(c, value)

        private fun note(c: BluetoothGattCharacteristic, v: ByteArray?) {
            val n = JSONObject().put("service", c.service.uuid.toString()).put("char", c.uuid.toString()).put("data", BtCodec.encode(v ?: ByteArray(0)))
            if (!notes.offer(n)) { notes.poll(); notes.offer(n) }
        }

        private fun finish(v: ByteArray?, status: Int) {
            opValue = v
            opStatus = status
            op?.countDown()
        }

        /** GATT allows one outstanding operation: serialise and wait for its callback. */
        @Synchronized
        fun <T> run(what: String, start: () -> Boolean, done: (ByteArray?) -> T): T {
            if (!connected) throw IllegalStateException("BLE connection is closed${failure?.let { ": $it" } ?: ""}")
            val l = CountDownLatch(1)
            op = l
            if (!start()) throw IllegalStateException("$what could not be started")
            if (!l.await(10, TimeUnit.SECONDS)) throw IllegalStateException("$what timed out")
            if (!connected) throw IllegalStateException("BLE connection lost during $what")
            if (opStatus != BluetoothGatt.GATT_SUCCESS) throw IllegalStateException("$what failed (status $opStatus)")
            return done(opValue)
        }

        fun ch(s: UUID, c: UUID): BluetoothGattCharacteristic =
            g.getService(s)?.getCharacteristic(c) ?: throw IllegalArgumentException("no characteristic $c in service $s")

        fun read(s: UUID, c: UUID): JSONObject {
            val ch = ch(s, c)
            return run("read", { g.readCharacteristic(ch) }) { JSONObject().put("data", BtCodec.encode(it ?: ByteArray(0))) }
        }

        @Suppress("DEPRECATION")
        fun write(s: UUID, c: UUID, data: ByteArray, noResponse: Boolean): JSONObject {
            val ch = ch(s, c)
            val type = if (noResponse) BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE else BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
            return run("write", {
                if (Build.VERSION.SDK_INT >= 33) g.writeCharacteristic(ch, data, type) == android.bluetooth.BluetoothStatusCodes.SUCCESS
                else { ch.writeType = type; ch.value = data; g.writeCharacteristic(ch) }
            }) { JSONObject().put("ok", true) }
        }

        @Suppress("DEPRECATION")
        fun notify(s: UUID, c: UUID, enable: Boolean): JSONObject {
            val ch = ch(s, c)
            if (!g.setCharacteristicNotification(ch, enable)) throw IllegalStateException("could not change notifications")
            val d = ch.getDescriptor(UUID.fromString(CCCD)) ?: return JSONObject().put("ok", true)
            val indicate = ch.properties and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0
            val v = when { !enable -> BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE; indicate -> BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
                else -> BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE }
            return run("notify", {
                if (Build.VERSION.SDK_INT >= 33) g.writeDescriptor(d, v) == android.bluetooth.BluetoothStatusCodes.SUCCESS else { d.value = v; g.writeDescriptor(d) }
            }) { JSONObject().put("ok", true) }
        }

        fun poll(timeoutMs: Long): JSONArray {
            val out = JSONArray()
            notes.poll(timeoutMs, TimeUnit.MILLISECONDS)?.let { out.put(it) }
            while (out.length() < 256) out.put(notes.poll() ?: break)
            return out
        }

        fun services(): JSONArray = JSONArray(g.services.map { s ->
            JSONObject().put("uuid", s.uuid.toString()).put("characteristics", JSONArray(s.characteristics.map { c ->
                JSONObject().put("uuid", c.uuid.toString()).put("properties", JSONArray(props(c.properties)))
            }))
        })

        private fun props(p: Int) = listOfNotNull(
            "read".takeIf { p and BluetoothGattCharacteristic.PROPERTY_READ != 0 },
            "write".takeIf { p and BluetoothGattCharacteristic.PROPERTY_WRITE != 0 },
            "write_no_response".takeIf { p and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE != 0 },
            "notify".takeIf { p and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0 },
            "indicate".takeIf { p and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0 },
        )
    }

    private fun bleConnect(address: String, timeoutMs: Long): JSONObject {
        val d = need().getRemoteDevice(address)
        val id = "b" + ids.incrementAndGet()
        val cb = Gatt(id)
        cb.g = d.connectGatt(ctx, false, cb, BluetoothDevice.TRANSPORT_LE)
        if (!cb.ready.await(timeoutMs.coerceIn(1000, 60_000), TimeUnit.MILLISECONDS) || cb.failure != null || !cb.connected) {
            cb.g.close()
            throw IllegalStateException("BLE connect failed: ${cb.failure ?: "timed out"}")
        }
        gatts[id] = cb
        return JSONObject().put("id", id).put("address", address).put("services", cb.services())
    }

    private fun gatt(a: JSONObject) = gatts[a.getString("id")] ?: throw IllegalStateException("BLE connection is closed")

    private fun close(id: String) {
        sockets.remove(id)?.let { try { it.close() } catch (_: Exception) {} }
        gatts.remove(id)?.let { try { it.g.disconnect(); it.g.close() } catch (_: Exception) {} }
    }

    /** Script exit: drop every connection. */
    fun closeAll() {
        (sockets.keys + gatts.keys).toList().forEach { close(it) }
    }
}
