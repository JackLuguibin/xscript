package com.xscript.pycharm

/** One row of the Device Projects list. */
data class DeviceProjectRow(val name: String, val running: Boolean)

object DeviceProjects {
    /** The device's projects, sorted, with the one it is running marked (GET /projects + GET /status). */
    fun load(client: DeviceClient): List<DeviceProjectRow> {
        val names = client.listProjects()
        val s = client.status()
        val running = if (s.get("running")?.asBoolean == true) s.get("project")?.takeIf { !it.isJsonNull }?.asString else null
        return names.sortedWith(String.CASE_INSENSITIVE_ORDER).map { DeviceProjectRow(it, it == running) }
    }
}
