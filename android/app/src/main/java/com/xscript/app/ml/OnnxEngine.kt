package com.xscript.app.ml

import ai.onnxruntime.NodeInfo
import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import ai.onnxruntime.TensorInfo
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * ONNX Runtime sessions for `xscript.android.onnx` (YOLO, PaddleOCR, custom models).
 *
 * Lives in the Python host process (:script / :eval), so tensors never cross a Binder.
 * Python owns all pre/post-processing; this class only moves float32 tensors in and out:
 *
 *   load(path, {"threads", "accel"})      → {"handle", "inputs", "outputs", "metadata"}
 *   run(handle, input, shape, f32 bytes)  → u32 header length + JSON header + output bytes
 */
object OnnxEngine {
    private val env: OrtEnvironment by lazy { OrtEnvironment.getEnvironment() }
    private val sessions = ConcurrentHashMap<String, OrtSession>()
    private val seq = AtomicInteger()

    fun load(path: String, optsJson: String): String = try {
        val opts = if (optsJson.isBlank()) JSONObject() else JSONObject(optsJson)
        val session = open(path, opts.optInt("threads", 4), opts.optString("accel"))
        val handle = "m" + seq.incrementAndGet()
        sessions[handle] = session
        JSONObject()
            .put("handle", handle)
            .put("inputs", describe(session.inputInfo))
            .put("outputs", describe(session.outputInfo))
            .put("metadata", JSONObject(session.metadata.customMetadata as Map<*, *>))
            .toString()
    } catch (t: Throwable) {
        JSONObject().put("error", t.message ?: t.toString()).toString()
    }

    private fun open(path: String, threads: Int, accel: String): OrtSession {
        fun options(nnapi: Boolean) = OrtSession.SessionOptions().apply {
            if (threads > 0) setIntraOpNumThreads(threads)
            setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
            if (nnapi) addNnapi()
        }
        if (accel.equals("nnapi", ignoreCase = true)) {
            try {
                return env.createSession(path, options(true))
            } catch (_: Throwable) {
                // Many models use ops NNAPI rejects; CPU always works.
            }
        }
        return env.createSession(path, options(false))
    }

    private fun describe(info: Map<String, NodeInfo>): JSONArray {
        val arr = JSONArray()
        for ((name, node) in info) {
            val t = node.info as? TensorInfo
            arr.put(
                JSONObject()
                    .put("name", name)
                    .put("shape", JSONArray(t?.shape?.toList() ?: emptyList<Long>()))
                    .put("type", t?.type?.name ?: "UNKNOWN"),
            )
        }
        return arr
    }

    /**
     * [reduce] = "argmax": float outputs come back as `<name>:idx` (i64) and `<name>:max`
     * (f32) over the last axis. OCR recognisers output [batch, T, ~18k classes]; reducing
     * here sends a few KB to Python instead of tens of MB.
     */
    fun run(handle: String, input: String, shapeJson: String, data: ByteArray, reduce: String = ""): ByteArray = try {
        val session = sessions[handle] ?: throw IllegalArgumentException("model not loaded: $handle")
        val shapeArr = JSONArray(shapeJson)
        val shape = LongArray(shapeArr.length()) { shapeArr.getLong(it) }
        val floats = ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer()
        OnnxTensor.createTensor(env, floats, shape).use { tensor ->
            session.run(mapOf(input to tensor)).use { result -> pack(result, reduce == "argmax") }
        }
    } catch (t: Throwable) {
        frame(JSONObject().put("error", t.message ?: t.toString()), emptyList())
    }

    private fun pack(result: OrtSession.Result, argmax: Boolean): ByteArray {
        val outputs = JSONArray()
        val chunks = ArrayList<ByteArray>()
        for (entry in result) {
            val tensor = entry.value as? OnnxTensor ?: continue
            val info = tensor.info
            if (argmax && info.type == ai.onnxruntime.OnnxJavaType.FLOAT && info.shape.isNotEmpty()) {
                val classes = info.shape.last().toInt()
                val fb = tensor.floatBuffer
                val rows = if (classes > 0) fb.remaining() / classes else 0
                val idx = ByteBuffer.allocate(rows * 8).order(ByteOrder.LITTLE_ENDIAN)
                val max = ByteBuffer.allocate(rows * 4).order(ByteOrder.LITTLE_ENDIAN)
                for (r in 0 until rows) {
                    var best = 0
                    var bestV = Float.NEGATIVE_INFINITY
                    val base = r * classes
                    for (c in 0 until classes) {
                        val v = fb.get(base + c)
                        if (v > bestV) {
                            bestV = v
                            best = c
                        }
                    }
                    idx.putLong(best.toLong())
                    max.putFloat(bestV)
                }
                val lead = JSONArray(info.shape.dropLast(1))
                outputs.put(JSONObject().put("name", entry.key + ":idx").put("shape", lead).put("dtype", "i64"))
                chunks.add(idx.array())
                outputs.put(JSONObject().put("name", entry.key + ":max").put("shape", lead).put("dtype", "f32"))
                chunks.add(max.array())
                continue
            }
            val bytes: ByteArray
            val dtype: String
            when (info.type) {
                ai.onnxruntime.OnnxJavaType.FLOAT -> {
                    val fb = tensor.floatBuffer
                    val bb = ByteBuffer.allocate(fb.remaining() * 4).order(ByteOrder.LITTLE_ENDIAN)
                    bb.asFloatBuffer().put(fb)
                    bytes = bb.array()
                    dtype = "f32"
                }
                ai.onnxruntime.OnnxJavaType.INT64 -> {
                    val lb = tensor.longBuffer
                    val bb = ByteBuffer.allocate(lb.remaining() * 8).order(ByteOrder.LITTLE_ENDIAN)
                    bb.asLongBuffer().put(lb)
                    bytes = bb.array()
                    dtype = "i64"
                }
                else -> continue
            }
            outputs.put(JSONObject().put("name", entry.key).put("shape", JSONArray(info.shape.toList())).put("dtype", dtype))
            chunks.add(bytes)
        }
        return frame(JSONObject().put("outputs", outputs), chunks)
    }

    private fun frame(header: JSONObject, chunks: List<ByteArray>): ByteArray {
        val head = header.toString().toByteArray(Charsets.UTF_8)
        val out = ByteArrayOutputStream(4 + head.size + chunks.sumOf { it.size })
        out.write(ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(head.size).array())
        out.write(head)
        chunks.forEach { out.write(it) }
        return out.toByteArray()
    }

    fun close(handle: String) {
        sessions.remove(handle)?.close()
    }
}
