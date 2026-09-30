package com.xscript.app.tools

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.OutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/**
 * 标注数据集 for YOLO training. Pure JVM (no Android types) so it is unit-testable.
 *
 * Layout under [root]/<dataset>/:
 *   meta.json            {"classes": ["btn", ...]}
 *   images/<id>.png      screenshots (or uploaded images)
 *   labels/<id>.json     {"width": W, "height": H, "boxes": [{"cls": 0, "rect": [l,t,r,b]}]}
 *
 * Boxes are stored in pixels so the web tool can edit them directly; [exportYolo]
 * converts to normalised `cls cx cy w h` lines in the Ultralytics layout.
 */
class DatasetStore(val root: File) {
    init {
        root.mkdirs()
    }

    fun list(): JSONArray {
        val arr = JSONArray()
        root.listFiles()?.filter { it.isDirectory && File(it, META).isFile }?.sortedBy { it.name }?.forEach { d ->
            arr.put(
                JSONObject()
                    .put("name", d.name)
                    .put("classes", meta(d.name).getJSONArray("classes"))
                    .put("images", images(d).size)
                    .put("labeled", images(d).count { labeled(d, it.nameWithoutExtension) }),
            )
        }
        return arr
    }

    fun create(name: String): JSONObject {
        val d = dir(name)
        d.mkdirs()
        File(d, "images").mkdirs()
        File(d, "labels").mkdirs()
        if (!File(d, META).isFile) writeMeta(name, JSONArray())
        return describe(name)
    }

    fun delete(name: String): Boolean = dir(name).deleteRecursively()

    fun exists(name: String): Boolean = isValidName(name) && File(dir(name), META).isFile

    fun describe(name: String): JSONObject {
        val d = requireDataset(name)
        val items = JSONArray()
        val classes = meta(name).getJSONArray("classes")
        val counts = IntArray(classes.length())
        images(d).forEach { f ->
            val id = f.nameWithoutExtension
            val label = readLabel(d, id)
            val boxes = label?.optJSONArray("boxes")
            if (boxes != null) {
                for (i in 0 until boxes.length()) {
                    val c = boxes.getJSONObject(i).optInt("cls", -1)
                    if (c in counts.indices) counts[c]++
                }
            }
            items.put(
                JSONObject()
                    .put("id", id)
                    .put("file", f.name)
                    .put("labeled", label != null)
                    .put("boxes", boxes?.length() ?: 0),
            )
        }
        return JSONObject().put("name", name).put("classes", classes)
            .put("counts", JSONArray(counts.toList())).put("items", items)
    }

    /** Rename a dataset directory. The new name must be valid and unused. */
    fun rename(name: String, to: String): JSONObject {
        val src = requireDataset(name)
        val dst = dir(to)
        require(!dst.exists()) { "dataset $to already exists" }
        require(src.renameTo(dst)) { "cannot rename $name" }
        return describe(to)
    }

    /**
     * Drop class [index]: boxes of that class are deleted and higher indices shift down by one,
     * so the remaining labels keep pointing at the same names.
     */
    fun deleteClass(name: String, index: Int): JSONObject {
        val d = requireDataset(name)
        val classes = meta(name).getJSONArray("classes")
        require(index in 0 until classes.length()) { "class index $index out of range" }
        File(d, "labels").listFiles()?.filter { it.extension == "json" }?.forEach { f ->
            val label = JSONObject(f.readText())
            val boxes = label.optJSONArray("boxes") ?: return@forEach
            val kept = JSONArray()
            for (i in 0 until boxes.length()) {
                val b = boxes.getJSONObject(i)
                val c = b.optInt("cls", -1)
                if (c == index) continue
                if (c > index) b.put("cls", c - 1)
                kept.put(b)
            }
            f.writeText(label.put("boxes", kept).toString())
        }
        val next = JSONArray()
        for (i in 0 until classes.length()) if (i != index) next.put(classes.getString(i))
        writeMeta(name, next)
        return describe(name)
    }

    /**
     * Replace the class list. Labels store class indices, so a list may only rename or
     * append: shrinking below a class index that labels still use is rejected.
     */
    fun setClasses(name: String, classes: JSONArray): JSONObject {
        val d = requireDataset(name)
        val seen = HashSet<String>()
        val clean = JSONArray()
        for (i in 0 until classes.length()) {
            val c = classes.optString(i).trim()
            require(c.isNotEmpty() && c.length <= 64 && !c.contains('\n')) { "bad class name: $c" }
            require(seen.add(c)) { "duplicate class: $c" }
            clean.put(c)
        }
        val used = maxUsedClass(d)
        require(clean.length() > used) { "class ${used} is still used by labels; remove those boxes first" }
        writeMeta(name, clean)
        return describe(name)
    }

    /** Store an image (PNG/JPEG bytes). Returns the new item id. */
    fun addImage(name: String, bytes: ByteArray, ext: String): String {
        val d = requireDataset(name)
        val e = ext.lowercase().removePrefix(".")
        require(e in IMAGE_EXT) { "unsupported image type: $ext" }
        require(sniff(bytes) != null) { "not a PNG or JPEG image" }
        val id = nextId(d)
        File(d, "images/$id.$e").writeBytes(bytes)
        return id
    }

    fun imageFile(name: String, id: String): File? {
        val d = requireDataset(name)
        requireId(id)
        return IMAGE_EXT.map { File(d, "images/$id.$it") }.firstOrNull { it.isFile }
    }

    fun deleteImage(name: String, id: String): Boolean {
        val f = imageFile(name, id) ?: return false
        File(requireDataset(name), "labels/$id.json").delete()
        return f.delete()
    }

    fun label(name: String, id: String): JSONObject {
        val d = requireDataset(name)
        requireId(id)
        require(imageFile(name, id) != null) { "missing image $id" }
        return readLabel(d, id) ?: JSONObject().put("width", 0).put("height", 0).put("boxes", JSONArray())
    }

    /** Drop the label file so the image counts as unlabelled again (not a negative sample). */
    fun deleteLabel(name: String, id: String): Boolean {
        val d = requireDataset(name)
        requireId(id)
        return File(d, "labels/$id.json").delete()
    }

    /**
     * Save boxes for an image. Rects are clamped to the image and normalised so
     * l < r and t < b; zero-area boxes are dropped.
     */
    fun saveLabel(name: String, id: String, body: JSONObject): JSONObject {
        val d = requireDataset(name)
        requireId(id)
        require(imageFile(name, id) != null) { "missing image $id" }
        val w = body.optInt("width")
        val h = body.optInt("height")
        require(w > 0 && h > 0) { "width/height required" }
        val classCount = meta(name).getJSONArray("classes").length()
        val boxes = JSONArray()
        val src = body.optJSONArray("boxes") ?: JSONArray()
        for (i in 0 until src.length()) {
            val b = src.getJSONObject(i)
            val cls = b.getInt("cls")
            require(cls in 0 until classCount) { "class index $cls out of range" }
            val r = b.getJSONArray("rect")
            val l = minOf(r.getInt(0), r.getInt(2)).coerceIn(0, w)
            val t = minOf(r.getInt(1), r.getInt(3)).coerceIn(0, h)
            val rr = maxOf(r.getInt(0), r.getInt(2)).coerceIn(0, w)
            val bb = maxOf(r.getInt(1), r.getInt(3)).coerceIn(0, h)
            if (rr - l < 1 || bb - t < 1) continue
            boxes.put(JSONObject().put("cls", cls).put("rect", JSONArray(listOf(l, t, rr, bb))))
        }
        val out = JSONObject().put("width", w).put("height", h).put("boxes", boxes)
        File(d, "labels").mkdirs()
        File(d, "labels/$id.json").writeText(out.toString())
        return out
    }

    /**
     * Ultralytics layout zip: images/{train,val}/, labels/{train,val}/, data.yaml.
     * Every [valEvery]-th labelled image goes to val (at least one when possible).
     * Unlabelled images are skipped; an image with an empty box list is kept as a
     * negative sample with an empty label file.
     */
    fun exportYolo(name: String, out: OutputStream, valEvery: Int = 5): Int {
        val d = requireDataset(name)
        val classes = meta(name).getJSONArray("classes")
        require(classes.length() > 0) { "dataset has no classes" }
        val items = images(d).filter { labeled(d, it.nameWithoutExtension) }
        require(items.isNotEmpty()) { "no labelled images" }
        ZipOutputStream(out).use { zip ->
            items.forEachIndexed { i, f ->
                val split = if (items.size > 1 && i % valEvery == valEvery - 1) "val" else "train"
                val id = f.nameWithoutExtension
                zip.putNextEntry(ZipEntry("images/$split/${f.name}"))
                f.inputStream().use { it.copyTo(zip) }
                zip.closeEntry()
                zip.putNextEntry(ZipEntry("labels/$split/$id.txt"))
                zip.write(yoloLines(readLabel(d, id)!!).toByteArray(Charsets.UTF_8))
                zip.closeEntry()
            }
            // With a single image, reuse it for val so training tools do not reject the set.
            val hasVal = items.size > 1 && items.indices.any { it % valEvery == valEvery - 1 }
            if (!hasVal) {
                val f = items.last()
                zip.putNextEntry(ZipEntry("images/val/${f.name}"))
                f.inputStream().use { it.copyTo(zip) }
                zip.closeEntry()
                zip.putNextEntry(ZipEntry("labels/val/${f.nameWithoutExtension}.txt"))
                zip.write(yoloLines(readLabel(d, f.nameWithoutExtension)!!).toByteArray(Charsets.UTF_8))
                zip.closeEntry()
            }
            zip.putNextEntry(ZipEntry("data.yaml"))
            zip.write(dataYaml(classes).toByteArray(Charsets.UTF_8))
            zip.closeEntry()
        }
        return items.size
    }

    // ---- helpers ----

    private fun dir(name: String) = File(root, sanitize(name))

    private fun requireDataset(name: String): File {
        val d = dir(name)
        require(File(d, META).isFile) { "missing dataset $name" }
        return d
    }

    private fun meta(name: String): JSONObject = JSONObject(File(dir(name), META).readText())

    private fun writeMeta(name: String, classes: JSONArray) {
        File(dir(name), META).writeText(JSONObject().put("classes", classes).toString())
    }

    private fun images(d: File): List<File> =
        File(d, "images").listFiles()
            ?.filter { it.isFile && it.extension.lowercase() in IMAGE_EXT && ID.matches(it.nameWithoutExtension) }
            ?.sortedBy { it.name }
            .orEmpty()

    private fun labeled(d: File, id: String) = File(d, "labels/$id.json").isFile

    /** Highest class index referenced by any label, or -1. */
    private fun maxUsedClass(d: File): Int {
        var max = -1
        File(d, "labels").listFiles()?.filter { it.extension == "json" }?.forEach { f ->
            val boxes = JSONObject(f.readText()).optJSONArray("boxes") ?: return@forEach
            for (i in 0 until boxes.length()) max = maxOf(max, boxes.getJSONObject(i).optInt("cls", -1))
        }
        return max
    }

    private fun readLabel(d: File, id: String): JSONObject? {
        val f = File(d, "labels/$id.json")
        return if (f.isFile) JSONObject(f.readText()) else null
    }

    private fun nextId(d: File): String {
        val max = images(d).mapNotNull { it.nameWithoutExtension.toIntOrNull() }.maxOrNull() ?: 0
        return "%06d".format(max + 1)
    }

    companion object {
        private const val META = "meta.json"
        private val IMAGE_EXT = listOf("png", "jpg", "jpeg")
        private val NAME = Regex("""[\p{L}\p{N}_-]{1,64}""")
        private val ID = Regex("""\d{1,9}""")

        fun isValidName(name: String) = NAME.matches(name)

        fun sanitize(name: String): String {
            require(isValidName(name)) { "invalid dataset name: $name" }
            return name
        }

        private fun requireId(id: String) = require(ID.matches(id)) { "invalid image id: $id" }

        /** "png" / "jpg" from magic bytes, or null. */
        fun sniff(bytes: ByteArray): String? = when {
            bytes.size >= 8 && bytes[0] == 0x89.toByte() && bytes[1] == 'P'.code.toByte() &&
                bytes[2] == 'N'.code.toByte() && bytes[3] == 'G'.code.toByte() -> "png"
            bytes.size >= 3 && bytes[0] == 0xFF.toByte() && bytes[1] == 0xD8.toByte() && bytes[2] == 0xFF.toByte() -> "jpg"
            else -> null
        }

        /** Label JSON -> YOLO txt ("cls cx cy w h", normalised, 6 decimals). */
        fun yoloLines(label: JSONObject): String {
            val w = label.getInt("width").toDouble()
            val h = label.getInt("height").toDouble()
            val boxes = label.optJSONArray("boxes") ?: return ""
            val sb = StringBuilder()
            for (i in 0 until boxes.length()) {
                val b = boxes.getJSONObject(i)
                val r = b.getJSONArray("rect")
                val l = r.getDouble(0)
                val t = r.getDouble(1)
                val rr = r.getDouble(2)
                val bb = r.getDouble(3)
                sb.append(b.getInt("cls")).append(' ')
                    .append(fmt((l + rr) / 2 / w)).append(' ')
                    .append(fmt((t + bb) / 2 / h)).append(' ')
                    .append(fmt((rr - l) / w)).append(' ')
                    .append(fmt((bb - t) / h)).append('\n')
            }
            return sb.toString()
        }

        fun dataYaml(classes: JSONArray): String {
            val sb = StringBuilder()
            sb.append("# Generated by XScript 标注工具\n")
            sb.append("path: .\ntrain: images/train\nval: images/val\n")
            sb.append("nc: ").append(classes.length()).append('\n')
            sb.append("names:\n")
            for (i in 0 until classes.length()) {
                sb.append("  ").append(i).append(": ").append(yamlString(classes.getString(i))).append('\n')
            }
            return sb.toString()
        }

        private fun yamlString(s: String): String = "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

        private fun fmt(v: Double): String = String.format(java.util.Locale.US, "%.6f", v.coerceIn(0.0, 1.0))
    }
}
