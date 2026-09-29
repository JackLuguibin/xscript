package com.xscript.app.tools

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Screenshots frozen for the 图色工具 and 标注工具. Every color pick, crop and vision test
 * runs against one saved PNG, so the numbers stay consistent while the user works.
 * Pure JVM; the caller supplies the PNG bytes. Oldest snapshots beyond [keep] are pruned.
 */
class SnapshotStore(val root: File, private val keep: Int = 20) {
    init {
        root.mkdirs()
    }

    fun save(png: ByteArray, width: Int, height: Int): JSONObject {
        require(DatasetStore.sniff(png) == "png") { "snapshot must be PNG" }
        val id = System.currentTimeMillis().toString() + "_" + (seq++ % 1000)
        File(root, "$id.png").writeBytes(png)
        File(root, "$id.json").writeText(JSONObject().put("width", width).put("height", height).toString())
        prune()
        return describe(id)
    }

    fun file(id: String): File? {
        require(ID.matches(id)) { "invalid snapshot id" }
        return File(root, "$id.png").takeIf { it.isFile }
    }

    fun describe(id: String): JSONObject {
        val meta = File(root, "$id.json")
        val m = if (meta.isFile) JSONObject(meta.readText()) else JSONObject()
        return JSONObject()
            .put("id", id)
            .put("width", m.optInt("width"))
            .put("height", m.optInt("height"))
            .put("url", "/tools/snapshots/$id.png")
    }

    fun list(): JSONArray {
        val arr = JSONArray()
        ids().asReversed().forEach { arr.put(describe(it)) }
        return arr
    }

    private fun ids(): List<String> =
        root.listFiles()?.filter { it.isFile && it.extension == "png" }?.map { it.nameWithoutExtension }
            ?.filter { ID.matches(it) }?.sortedWith(compareBy({ it.substringBefore('_').toLong() }, { it }))
            .orEmpty()

    private fun prune() {
        val all = ids()
        if (all.size <= keep) return
        all.take(all.size - keep).forEach {
            File(root, "$it.png").delete()
            File(root, "$it.json").delete()
        }
    }

    companion object {
        private val ID = Regex("""\d{1,15}_\d{1,3}""")

        @Volatile
        private var seq = 0
    }
}
