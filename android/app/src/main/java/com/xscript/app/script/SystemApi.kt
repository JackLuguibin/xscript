package com.xscript.app.script

import android.app.ActivityManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.media.AudioManager
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.provider.Settings
import android.speech.tts.TextToSpeech
import com.xscript.app.XscriptApp
import com.xscript.app.net.NetworkInfo
import com.xscript.app.root.RootShell
import com.xscript.app.runtime.AutomationDispatcher
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Device / app / media helpers for `ascript.android.system` and `xscript.android.system`. */
object SystemApi {
    private val ctx: Context get() = XscriptApp.instance
    private val main = Handler(Looper.getMainLooper())

    fun call(op: String, arg: String): String {
        val a = if (arg.startsWith("{")) JSONObject(arg) else JSONObject().put("v", arg)
        return when (op) {
            "open" -> open(a.optString("v")).toString()
            "browser" -> startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(a.optString("v")))).toString()
            "open_setting" -> startActivity(
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + a.optString("v"))),
            ).toString()
            "app_name" -> appName(a.optString("v")).orEmpty()
            "apps" -> apps().toString()
            "stop_app" -> RootShell.exec("am force-stop " + RootShell.quote(a.optString("v"))).ok.toString()
            "device" -> device().toString()
            "battery" -> battery().toString()
            "memory" -> memory().toString()
            "screen_on" -> (ctx.getSystemService(Context.POWER_SERVICE) as PowerManager).isInteractive.toString()
            "wake_up" -> wakeUp().toString()
            "android_id" -> androidId()
            "clip_put" -> onMain { clipboard().setPrimaryClip(ClipData.newPlainText("xscript", a.optString("v"))); "ok" }
            "clip_get" -> onMain { clipboard().primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(ctx)?.toString().orEmpty() }
            // commit(), not apply(): the script process is killed as soon as a run ends, which
            // would drop an asynchronous write made just before exit.
            "kv_put" -> {
                kv().edit().putString(a.getString("key"), a.getString("value")).commit()
                "ok"
            }
            "kv_get" -> kv().getString(a.getString("key"), null) ?: "\u0000"
            "kv_remove" -> {
                kv().edit().remove(a.getString("key")).commit()
                "ok"
            }
            "shell" -> shell(a.optString("cmd"), a.optBoolean("root", true), a.optLong("timeout", 30_000)).toString()
            "root" -> RootShell.available().toString()
            "vibrate" -> vibrate(a.optLong("v", 200)).toString()
            "cancel_vibrate" -> vibrator().cancel().let { "ok" }
            "volume" -> volume(a).toString()
            "get_volume" -> audio().getStreamVolume(a.optInt("type", AudioManager.STREAM_MUSIC)).toString()
            "max_volume" -> audio().getStreamMaxVolume(a.optInt("type", AudioManager.STREAM_MUSIC)).toString()
            "brightness" -> brightness(a.optInt("v", -1)).toString()
            "get_brightness" -> Settings.System.getInt(ctx.contentResolver, Settings.System.SCREEN_BRIGHTNESS, -1).toString()
            "tts" -> speak(a.optString("v")).toString()
            "models_dir" -> com.xscript.app.ml.ModelStore.dir(ctx).absolutePath
            // Runtime pip installs: private storage, shared by :script and :eval, kept across updates.
            "pip_home" -> java.io.File(ctx.filesDir, "pip").apply { mkdirs() }.absolutePath
            "current_app" -> AutomationDispatcher.control("current_app", "")
            "status" -> AutomationDispatcher.control("status", "")
            else -> throw IllegalArgumentException("unknown system op $op")
        }
    }

    private fun <T> onMain(block: () -> T): T {
        if (Looper.myLooper() == Looper.getMainLooper()) return block()
        val ref = AtomicReference<Any?>()
        val latch = CountDownLatch(1)
        main.post {
            try {
                ref.set(block())
            } catch (t: Throwable) {
                ref.set(t)
            } finally {
                latch.countDown()
            }
        }
        latch.await(5, TimeUnit.SECONDS)
        val v = ref.get()
        if (v is Throwable) throw v
        @Suppress("UNCHECKED_CAST")
        return v as T
    }

    private fun startActivity(intent: Intent): Boolean = try {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ctx.startActivity(intent)
        true
    } catch (_: Exception) {
        false
    }

    /** Accepts a package name or an app label. Background activity starts need the overlay grant on 10+. */
    private fun open(nameOrPkg: String): Boolean {
        val pm = ctx.packageManager
        val pkg = if (isInstalled(nameOrPkg)) nameOrPkg else findPackageByLabel(nameOrPkg) ?: return false
        val intent = pm.getLaunchIntentForPackage(pkg)
        if (intent != null && startActivity(intent)) return true
        if (RootShell.known() == true) {
            return RootShell.exec("monkey -p " + RootShell.quote(pkg) + " -c android.intent.category.LAUNCHER 1").ok
        }
        return false
    }

    private fun isInstalled(pkg: String): Boolean = try {
        ctx.packageManager.getPackageInfo(pkg, 0)
        true
    } catch (_: PackageManager.NameNotFoundException) {
        false
    }

    private fun findPackageByLabel(label: String): String? {
        val pm = ctx.packageManager
        val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        return pm.queryIntentActivities(launcher, 0)
            .firstOrNull { it.loadLabel(pm).toString() == label }
            ?.activityInfo?.packageName
    }

    private fun appName(pkg: String): String? = try {
        val pm = ctx.packageManager
        pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
    } catch (_: Exception) {
        null
    }

    private fun apps(): JSONArray {
        val pm = ctx.packageManager
        val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val out = JSONArray()
        val seen = HashSet<String>()
        for (ri in pm.queryIntentActivities(launcher, 0)) {
            val pkg = ri.activityInfo.packageName
            if (!seen.add(pkg)) continue
            val info = try {
                pm.getPackageInfo(pkg, 0)
            } catch (_: Exception) {
                null
            }
            out.put(
                JSONObject()
                    .put("name", ri.loadLabel(pm).toString())
                    .put("packageName", pkg)
                    .put("versionName", info?.versionName ?: "")
                    .put("versionCode", if (info == null) 0 else if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()),
            )
        }
        return out
    }

    private fun device(): JSONObject {
        val m = ctx.resources.displayMetrics
        val statusBarId = ctx.resources.getIdentifier("status_bar_height", "dimen", "android")
        return JSONObject()
            .put("id", androidId())
            .put("name", Build.DEVICE ?: "")
            .put("brand", Build.BRAND ?: "")
            .put("model", Build.MODEL ?: "")
            .put("manufacturer", Build.MANUFACTURER ?: "")
            .put("sdk", Build.VERSION.SDK_INT)
            .put("version", Build.VERSION.RELEASE ?: "")
            .put("abi", Build.SUPPORTED_ABIS.firstOrNull() ?: "")
            .put("abis", JSONArray(Build.SUPPORTED_ABIS.toList()))
            .put("width", m.widthPixels)
            .put("height", m.heightPixels)
            .put("density", m.density.toDouble())
            .put("densityDpi", m.densityDpi)
            .put("status_bar_height", if (statusBarId > 0) ctx.resources.getDimensionPixelSize(statusBarId) else 0)
            .put("ip", NetworkInfo.localIp(ctx))
    }

    private fun androidId(): String =
        Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ANDROID_ID) ?: ""

    private fun battery(): JSONObject {
        val i = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = i?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = i?.getIntExtra(BatteryManager.EXTRA_SCALE, 100) ?: 100
        val status = i?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        return JSONObject()
            .put("level", if (scale > 0 && level >= 0) level * 100 / scale else -1)
            .put("charging", status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL)
            .put("temperature", (i?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) ?: 0) / 10.0)
            .put("voltage", i?.getIntExtra(BatteryManager.EXTRA_VOLTAGE, 0) ?: 0)
    }

    private fun memory(): JSONObject {
        val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val mi = ActivityManager.MemoryInfo()
        am.getMemoryInfo(mi)
        val rt = Runtime.getRuntime()
        return JSONObject()
            .put("total", mi.totalMem)
            .put("available", mi.availMem)
            .put("low", mi.lowMemory)
            .put("app_used", rt.totalMemory() - rt.freeMemory())
            .put("app_max", rt.maxMemory())
    }

    @Suppress("DEPRECATION")
    private fun wakeUp(): Boolean {
        val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
        if (pm.isInteractive) return true
        if (RootShell.known() == true) return RootShell.exec("input keyevent 224").ok
        val wl = pm.newWakeLock(
            PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP,
            "xscript:wake",
        )
        wl.acquire(3000)
        return true
    }

    private fun clipboard() = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager

    private fun kv() = ctx.getSharedPreferences("xscript_kv", Context.MODE_MULTI_PROCESS)

    private fun shell(cmd: String, root: Boolean, timeout: Long): JSONObject {
        val res = if (root && RootShell.available()) {
            RootShell.exec(cmd, timeout)
        } else {
            val p = ProcessBuilder("sh", "-c", cmd).start()
            p.outputStream.close()
            val out = p.inputStream.bufferedReader().readText()
            val err = p.errorStream.bufferedReader().readText()
            p.waitFor(timeout, TimeUnit.MILLISECONDS)
            RootShell.Result(if (p.isAlive) -1 else p.exitValue(), out, err)
        }
        return JSONObject().put("code", res.code).put("out", res.out).put("err", res.err)
    }

    private fun vibrator(): Vibrator {
        @Suppress("DEPRECATION")
        return ctx.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
    }

    private fun vibrate(ms: Long): Boolean {
        val v = vibrator()
        if (Build.VERSION.SDK_INT >= 26) {
            v.vibrate(VibrationEffect.createOneShot(ms.coerceAtLeast(1), VibrationEffect.DEFAULT_AMPLITUDE))
        } else {
            @Suppress("DEPRECATION")
            v.vibrate(ms)
        }
        return true
    }

    private fun audio() = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    private fun volume(a: JSONObject): Boolean {
        val type = a.optInt("type", AudioManager.STREAM_MUSIC)
        val max = audio().getStreamMaxVolume(type)
        val percent = a.optInt("v", 50).coerceIn(0, 100)
        audio().setStreamVolume(type, max * percent / 100, 0)
        return true
    }

    private fun brightness(value: Int): Boolean {
        if (value < 0) return false
        return try {
            Settings.System.putInt(ctx.contentResolver, Settings.System.SCREEN_BRIGHTNESS, value.coerceIn(0, 255))
            true
        } catch (_: Exception) {
            RootShell.known() == true && RootShell.exec("settings put system screen_brightness ${value.coerceIn(0, 255)}").ok
        }
    }

    @Volatile
    private var tts: TextToSpeech? = null

    private fun speak(text: String): Boolean {
        val ready = CountDownLatch(1)
        var ok = true
        val engine = tts ?: onMain {
            TextToSpeech(ctx) { status ->
                ok = status == TextToSpeech.SUCCESS
                ready.countDown()
            }
        }.also {
            tts = it
            ready.await(5, TimeUnit.SECONDS)
            it.language = Locale.getDefault()
        }
        if (!ok) return false
        engine.speak(text, TextToSpeech.QUEUE_ADD, null, "xs" + System.nanoTime())
        return true
    }
}
