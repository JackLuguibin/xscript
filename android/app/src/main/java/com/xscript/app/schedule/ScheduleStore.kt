package com.xscript.app.schedule

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.time.ZoneId
import java.util.UUID

/**
 * Schedules persisted as one JSON file. Only the main process touches it; methods are
 * synchronized because HTTP, binder and alarm threads all call in.
 */
class ScheduleStore(private val file: File, private val zone: () -> ZoneId = { ZoneId.systemDefault() }) {
    @Synchronized
    fun list(project: String? = null): List<Schedule> =
        load().filter { project == null || it.project == project }

    @Synchronized
    fun get(id: String): Schedule? = load().firstOrNull { it.id == id }

    @Synchronized
    fun add(request: JSONObject, now: Long): Schedule {
        val all = load().toMutableList()
        require(all.size < MAX) { "too many schedules (max $MAX)" }
        val s = Schedule.fromRequest(request, newId(all), now, zone())
        all.add(s)
        save(all)
        return s
    }

    @Synchronized
    fun update(id: String, request: JSONObject, now: Long): Schedule {
        val all = load().toMutableList()
        val i = all.indexOfFirst { it.id == id }
        require(i >= 0) { "missing schedule $id" }
        val s = Schedule.fromRequest(request, id, now, zone(), all[i])
        all[i] = s
        save(all)
        return s
    }

    @Synchronized
    fun remove(id: String): Boolean {
        val all = load()
        val keep = all.filter { it.id != id }
        if (keep.size == all.size) return false
        save(keep)
        return true
    }

    @Synchronized
    fun removeProject(project: String): Int {
        val all = load()
        val keep = all.filter { it.project != project }
        if (keep.size != all.size) save(keep)
        return all.size - keep.size
    }

    /** Apply [block] to every schedule and persist the result. */
    @Synchronized
    fun rewrite(block: (List<Schedule>) -> List<Schedule>): List<Schedule> {
        val out = block(load())
        save(out)
        return out
    }

    private fun load(): List<Schedule> {
        if (!file.isFile) return emptyList()
        return try {
            val arr = JSONObject(file.readText()).optJSONArray("schedules") ?: JSONArray()
            (0 until arr.length()).mapNotNull { i ->
                try {
                    Schedule.fromJson(arr.getJSONObject(i))
                } catch (_: Exception) {
                    null
                }
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun save(list: List<Schedule>) {
        file.parentFile?.mkdirs()
        val tmp = File(file.parentFile, file.name + ".tmp")
        tmp.writeText(JSONObject().put("schedules", JSONArray(list.map { it.toJson() })).toString())
        if (!tmp.renameTo(file)) {
            file.writeText(tmp.readText())
            tmp.delete()
        }
    }

    private fun newId(existing: List<Schedule>): String {
        val ids = existing.map { it.id }.toSet()
        while (true) {
            val id = UUID.randomUUID().toString().substring(0, 8)
            if (id !in ids) return id
        }
    }

    companion object {
        const val MAX = 100
    }
}
