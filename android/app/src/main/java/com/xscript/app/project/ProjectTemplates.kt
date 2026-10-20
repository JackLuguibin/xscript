package com.xscript.app.project

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * New-project templates (assets/templates/projects.json, the same set the VS Code extension ships;
 * its unit test keeps the two copies identical). `{{name}}` in a file is replaced by the project name.
 */
class ProjectTemplates(json: String) {
    class Template(val id: String, val label: String, val detail: String, val files: Map<String, String>)

    val all: List<Template> = parse(json)

    fun find(id: String): Template? = all.firstOrNull { it.id == id }

    /** Files of template [id] for project [name]; IllegalArgumentException (→ 400) for an unknown id. */
    fun render(id: String, name: String): Map<String, String> {
        val t = find(id) ?: throw IllegalArgumentException("未知模板: $id")
        return t.files.mapValues { it.value.replace("{{name}}", name) }
    }

    /** `[{id, label, detail}]` for GET /project-templates. */
    fun describe(): JSONArray = JSONArray().also { arr ->
        all.forEach { arr.put(JSONObject().put("id", it.id).put("label", it.label).put("detail", it.detail)) }
    }

    companion object {
        const val DEFAULT = "empty"
        private const val ASSET = "templates/projects.json"

        @Volatile
        private var cached: ProjectTemplates? = null

        fun load(context: Context): ProjectTemplates = cached ?: synchronized(this) {
            cached ?: ProjectTemplates(context.assets.open(ASSET).bufferedReader(Charsets.UTF_8).use { it.readText() })
                .also { cached = it }
        }

        private fun parse(json: String): List<Template> {
            val arr = JSONObject(json).getJSONArray("templates")
            return (0 until arr.length()).map { i ->
                val o = arr.getJSONObject(i)
                val files = o.getJSONObject("files")
                val map = LinkedHashMap<String, String>()
                for (key in files.keys()) {
                    // Template paths are trusted assets, but keep them inside the project anyway.
                    ProjectStore.normalizeRel(key)
                    map[key] = files.getString(key)
                }
                require(map.containsKey("__init__.py")) { "template ${o.getString("id")} has no __init__.py" }
                Template(o.getString("id"), o.getString("label"), o.optString("detail"), map)
            }
        }
    }
}
