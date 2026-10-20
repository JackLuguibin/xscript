package com.xscript.app.runtime

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import com.xscript.app.XscriptApp
import com.xscript.app.script.OcrEngine
import com.xscript.app.script.ScriptUi
import com.xscript.app.script.SystemApi
import java.io.File
import java.io.FileOutputStream

/**
 * Static entry points for Python (`from com.xscript.app.runtime import Bridge`).
 * Everything here runs in the Python host process; automation calls hop to the main
 * process through [AutomationDispatcher].
 */
object Bridge {
    // ---- gestures & input ----
    @JvmStatic
    fun click(x: Int, y: Int, durMs: Int): Boolean = AutomationDispatcher.click(x, y, durMs)

    @JvmStatic
    fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, durMs: Int): Boolean =
        AutomationDispatcher.swipe(x1, y1, x2, y2, durMs)

    @JvmStatic
    fun gesture(strokesJson: String): Boolean = AutomationDispatcher.gesture(strokesJson)

    @JvmStatic
    fun touch(action: Int, x: Int, y: Int, durMs: Int): Boolean = AutomationDispatcher.touch(action, x, y, durMs)

    @JvmStatic
    fun globalAction(name: String): Boolean = AutomationDispatcher.globalAction(name)

    @JvmStatic
    fun inputText(text: String): Boolean = AutomationDispatcher.inputText(text)

    // ---- nodes ----
    @JvmStatic
    fun dumpTree(mode: Int): String = AutomationDispatcher.dumpTree(mode)

    @JvmStatic
    fun clickNode(path: String): Boolean = AutomationDispatcher.nodeAction(path, "click", "")

    @JvmStatic
    fun setText(path: String, text: String): Boolean = AutomationDispatcher.nodeAction(path, "set_text", text)

    @JvmStatic
    fun nodeAction(path: String, action: String, arg: String): Boolean =
        AutomationDispatcher.nodeAction(path, action, arg)

    @JvmStatic
    fun isAccessibilityOn(): Boolean = AutomationDispatcher.isAccessibilityOn()

    // ---- capture ----
    @JvmStatic
    fun captureToFile(path: String): String = AutomationDispatcher.captureToFile(path)

    /** Raw RGBA frame with an 8-byte (w,h) header; empty when capture is unavailable. */
    @JvmStatic
    fun captureRaw(l: Int, t: Int, r: Int, b: Int): ByteArray = AutomationDispatcher.captureRaw(l, t, r, b)

    @JvmStatic
    fun captureBitmap(l: Int, t: Int, r: Int, b: Int): Bitmap? = AutomationDispatcher.captureBitmap(l, t, r, b)

    @JvmStatic
    fun bitmapToRaw(bitmap: Bitmap): ByteArray = FrameCodec.encode(bitmap)

    @JvmStatic
    fun rawToBitmap(raw: ByteArray): Bitmap? = FrameCodec.decode(raw)

    @JvmStatic
    fun loadBitmap(path: String, sampleSize: Int): Bitmap? {
        val opts = BitmapFactory.Options().apply {
            inSampleSize = sampleSize.coerceAtLeast(1)
            inPreferredConfig = Bitmap.Config.ARGB_8888
        }
        return BitmapFactory.decodeFile(path, opts)
    }

    @JvmStatic
    fun saveBitmap(bitmap: Bitmap, path: String, quality: Int): Boolean {
        val file = File(path)
        file.parentFile?.mkdirs()
        val format = if (path.lowercase().endsWith(".jpg") || path.lowercase().endsWith(".jpeg")) {
            Bitmap.CompressFormat.JPEG
        } else {
            Bitmap.CompressFormat.PNG
        }
        return FileOutputStream(file).use { bitmap.compress(format, quality.coerceIn(1, 100), it) }
    }

    // ---- OCR ----
    @JvmStatic
    fun ocr(bitmap: Bitmap, offsetX: Int, offsetY: Int, level: String): String =
        OcrEngine.recognize(XscriptApp.instance, bitmap, offsetX, offsetY, level)

    @JvmStatic
    fun ocrWarmup() = OcrEngine.warmUp(XscriptApp.instance)

    // ---- ONNX (YOLO / PaddleOCR; sessions live in this process) ----
    @JvmStatic
    fun onnxLoad(path: String, optsJson: String): String = com.xscript.app.ml.OnnxEngine.load(path, optsJson)

    @JvmStatic
    fun onnxRun(handle: String, input: String, shapeJson: String, data: ByteArray, reduce: String): ByteArray =
        com.xscript.app.ml.OnnxEngine.run(handle, input, shapeJson, data, reduce)

    @JvmStatic
    fun onnxClose(handle: String) = com.xscript.app.ml.OnnxEngine.close(handle)

    // ---- UI (overlay windows live in the Python host process) ----
    @JvmStatic
    fun ui(op: String, json: String): String = ScriptUi.call(op, json)

    @JvmStatic
    fun uiPoll(windowId: String, timeoutMs: Long): String = ScriptUi.poll(windowId, timeoutMs)

    // ---- system ----
    @JvmStatic
    fun system(op: String, arg: String): String = SystemApi.call(op, arg)

    @JvmStatic
    fun control(op: String, arg: String): String = AutomationDispatcher.control(op, arg)

    // ---- events (pushed by the main process into the script process)
    /** Next subscribed event as JSON, or "" after [timeoutMs]. */
    @JvmStatic
    fun pollEvent(timeoutMs: Long): String =
        ScriptService.events.poll(timeoutMs.coerceAtLeast(0L), java.util.concurrent.TimeUnit.MILLISECONDS).orEmpty()

    // ---- logs ----
    @JvmStatic
    fun appendLog(stream: String, line: String) {
        LogBuffer.append(XscriptApp.instance, stream, line)
    }
}
