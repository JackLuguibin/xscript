package com.xscript.pycharm

import com.google.gson.JsonParser
import java.nio.file.Files
import java.nio.file.Path

/** A new-project template; `files` maps a relative path to its content with [Templates.placeholder] for the name. */
data class Template(val id: String, val label: String, val detail: String, val files: Map<String, String>)

/**
 * New-project templates: the same set as the VS Code extension (templates.json is generated from its newProject.ts by
 * ide/vscode-extension/scripts/export-templates.js, and CI fails when they differ).
 */
object Templates {
    private val data by lazy {
        val text = Templates::class.java.getResourceAsStream("/templates.json")!!.use { String(it.readBytes(), Charsets.UTF_8) }
        JsonParser.parseString(text).asJsonObject
    }
    val placeholder: String get() = data.get("name_placeholder").asString

    val all: List<Template> by lazy {
        data.getAsJsonArray("templates").map { el ->
            val o = el.asJsonObject
            Template(o.get("id").asString, o.get("label").asString, o.get("detail").asString,
                o.getAsJsonObject("files").entrySet().associate { it.key to it.value.asString })
        }
    }

    /** Same rule as the device (ProjectStore): a letter (incl. CJK) or underscore, then letters, digits, underscores. */
    fun validateName(name: String): String? = when {
        name.isEmpty() -> "Enter a project name"
        !Regex("^[\\p{L}_][\\p{L}\\p{N}_]*$").matches(name) -> "Use letters, digits and underscores, starting with a letter or underscore"
        else -> null
    }

    /** Creates parent/name from `template`; refuses an existing non-empty folder. Returns the project folder. */
    fun create(parent: Path, name: String, template: Template): Path {
        validateName(name)?.let { throw IllegalArgumentException(it) }
        val dir = parent.resolve(name)
        if (Files.isDirectory(dir) && Files.list(dir).use { it.findFirst().isPresent }) {
            throw IllegalArgumentException("$dir already exists and is not empty")
        }
        for ((rel, content) in template.files) {
            val target = dir.resolve(rel.replace('/', java.io.File.separatorChar)).normalize()
            require(target.startsWith(dir)) { "bad template path: $rel" }
            Files.createDirectories(target.parent)
            Files.writeString(target, content.replace(placeholder, name))
        }
        return dir
    }
}
