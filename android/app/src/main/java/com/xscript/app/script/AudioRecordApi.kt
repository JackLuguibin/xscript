package com.xscript.app.script

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.MediaRecorder
import android.os.Build
import android.os.SystemClock
import com.xscript.app.XscriptApp
import org.json.JSONObject
import java.io.File

/** Output container/codec chosen from the file extension (pure, so the JVM tests cover it). */
internal enum class RecordFormat(val ext: Set<String>) {
    AAC_M4A(setOf("m4a", "mp4", "aac")), AMR_NB(setOf("amr", "3gp")), OGG_OPUS(setOf("ogg", "opus"));

    companion object {
        /** null when the extension is not supported (wav/mp3 need an encoder Android does not ship). */
        fun forPath(path: String): RecordFormat? {
            val ext = path.substringAfterLast('/').substringAfterLast('.', "").lowercase()
            return values().firstOrNull { ext in it.ext }
        }
    }
}

/**
 * `media.recode`: one MediaRecorder per script process, microphone → file. Needs RECORD_AUDIO; Android only lets apps
 * record while visible (or from a microphone foreground service, which XScript does not run), so a script started from the
 * background may get silence or an error on Android 11+.
 */
object AudioRecordApi {
    private val ctx: Context get() = XscriptApp.instance
    private var recorder: MediaRecorder? = null
    private var path: String? = null
    private var started = 0L

    fun call(op: String, a: JSONObject): String = synchronized(this) {
        when (op) {
            "record_start" -> start(a.optString("path"))
            "record_stop" -> stop().toString()
            "record_status" -> status().toString()
            else -> throw IllegalArgumentException("unknown record op $op")
        }
    }

    private fun err(code: String, msg: String) = JSONObject().put("error", msg).put("code", code).toString()

    private fun start(p: String): String {
        if (ctx.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            return err("permission_denied", "RECORD_AUDIO permission required")
        }
        if (recorder != null) return err("busy", "already recording to $path")
        val fmt = RecordFormat.forPath(p) ?: return err("bad_format", "unsupported extension (use .m4a/.aac/.mp4, .amr/.3gp or .ogg/.opus)")
        if (fmt == RecordFormat.OGG_OPUS && Build.VERSION.SDK_INT < 29) return err("bad_format", ".ogg needs Android 10+")
        val f = File(p)
        f.parentFile?.mkdirs()
        @Suppress("DEPRECATION")
        val r = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(ctx) else MediaRecorder()
        try {
            r.setAudioSource(MediaRecorder.AudioSource.MIC)
            when (fmt) {
                RecordFormat.AAC_M4A -> {
                    r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                    r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                    r.setAudioEncodingBitRate(128_000)
                    r.setAudioSamplingRate(44_100)
                }
                RecordFormat.AMR_NB -> {
                    r.setOutputFormat(if (f.extension.lowercase() == "amr") MediaRecorder.OutputFormat.AMR_NB else MediaRecorder.OutputFormat.THREE_GPP)
                    r.setAudioEncoder(MediaRecorder.AudioEncoder.AMR_NB)
                }
                RecordFormat.OGG_OPUS -> {
                    r.setOutputFormat(MediaRecorder.OutputFormat.OGG)
                    r.setAudioEncoder(MediaRecorder.AudioEncoder.OPUS)
                }
            }
            r.setOutputFile(f.absolutePath)
            r.prepare()
            r.start()
        } catch (e: Exception) {
            r.release()
            return err("failed", "recording failed: ${e.message ?: e}")
        }
        recorder = r
        path = f.absolutePath
        started = SystemClock.elapsedRealtime()
        return JSONObject().put("ok", true).put("path", path).toString()
    }

    private fun stop(): JSONObject {
        val r = recorder ?: return JSONObject().put("ok", false).put("recording", false)
        val out = JSONObject().put("path", path).put("duration_ms", SystemClock.elapsedRealtime() - started)
        try {
            r.stop()
            out.put("ok", true)
        } catch (e: RuntimeException) {
            // stop() right after start() (no audio captured) throws; the file is unusable then
            out.put("ok", false).put("error", "no audio captured")
            path?.let { File(it).delete() }
        } finally {
            r.release()
            recorder = null
            path = null
        }
        return out
    }

    private fun status(): JSONObject = JSONObject().put("recording", recorder != null).put("path", path ?: JSONObject.NULL)
        .put("duration_ms", if (recorder != null) SystemClock.elapsedRealtime() - started else 0)

    /** Script exit: never leave the microphone open. */
    fun close() = synchronized(this) { if (recorder != null) stop() }
}
