package com.xscript.app.script

import android.content.Context
import android.graphics.Bitmap
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.common.sdkinternal.MlKitContext
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.TextRecognizer
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * On-device OCR with the bundled ML Kit Chinese + Latin model. Runs in whatever
 * process Python lives in; ML Kit's init provider only covers the main process, so
 * other processes initialise it by hand.
 */
object OcrEngine {
    @Volatile
    private var recognizer: TextRecognizer? = null

    @Synchronized
    private fun client(context: Context): TextRecognizer {
        recognizer?.let { return it }
        try {
            MlKitContext.initializeIfNeeded(context.applicationContext)
        } catch (_: Throwable) {
        }
        val c = TextRecognition.getClient(ChineseTextRecognizerOptions.Builder().build())
        recognizer = c
        return c
    }

    @Volatile
    private var warming = false

    /**
     * Loads the recogniser and runs one tiny frame on a background thread, so the script's
     * first real OCR call does not pay for model initialisation (~50-160 ms on an emulator).
     * Idempotent; called by the runner only for projects whose source uses `ocr(`.
     */
    fun warmUp(context: Context) {
        if (recognizer != null || warming) return
        warming = true
        Thread({
            try {
                val bmp = Bitmap.createBitmap(64, 32, Bitmap.Config.ARGB_8888)
                bmp.eraseColor(android.graphics.Color.WHITE)
                Tasks.await(client(context).process(InputImage.fromBitmap(bmp, 0)), 20, TimeUnit.SECONDS)
                bmp.recycle()
            } catch (_: Throwable) {
                // Best effort: the first real call initialises the model again if this failed.
            }
        }, "xs-ocr-warmup").apply { isDaemon = true; priority = Thread.NORM_PRIORITY - 1 }.start()
    }

    /**
     * Returns a JSON array of lines:
     * {"text","confidence","rect":[l,t,r,b],"center_x","center_y","elements":[...]}
     * Coordinates are shifted by (offsetX, offsetY) so a cropped region maps back to the screen.
     */
    fun recognize(context: Context, bitmap: Bitmap, offsetX: Int, offsetY: Int, level: String): String {
        val result = Tasks.await(
            client(context).process(InputImage.fromBitmap(bitmap, 0)),
            20,
            TimeUnit.SECONDS,
        )
        val out = JSONArray()
        for (block in result.textBlocks) {
            if (level == "block") {
                val box = block.boundingBox ?: continue
                out.put(item(block.text, averageConfidence(block), box, offsetX, offsetY))
                continue
            }
            for (line in block.lines) {
                val box = line.boundingBox ?: continue
                val obj = item(line.text, line.confidence.toDouble(), box, offsetX, offsetY)
                val elements = JSONArray()
                for (el in line.elements) {
                    val eb = el.boundingBox ?: continue
                    elements.put(item(el.text, el.confidence.toDouble(), eb, offsetX, offsetY))
                }
                obj.put("elements", elements)
                out.put(obj)
            }
        }
        return out.toString()
    }

    private fun averageConfidence(block: com.google.mlkit.vision.text.Text.TextBlock): Double {
        if (block.lines.isEmpty()) return 0.0
        return block.lines.map { it.confidence.toDouble() }.average()
    }

    private fun item(text: String, confidence: Double, box: android.graphics.Rect, dx: Int, dy: Int): JSONObject {
        val l = box.left + dx
        val t = box.top + dy
        val r = box.right + dx
        val b = box.bottom + dy
        return JSONObject()
            .put("text", text)
            .put("confidence", if (confidence.isNaN()) 0.0 else confidence)
            .put("rect", JSONArray().put(l).put(t).put(r).put(b))
            .put("center_x", (l + r) / 2)
            .put("center_y", (t + b) / 2)
    }
}
