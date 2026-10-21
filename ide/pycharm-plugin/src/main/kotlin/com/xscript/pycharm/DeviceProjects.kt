package com.xscript.pycharm

import java.nio.file.Files
import java.nio.file.Path

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

    /**
     * Where a pulled copy of device project `name` lives in this IDE project: the project itself when its folder is
     * named `name`, else its sub-folder `name`; either must be a project (__init__.py or build.as). Same rule Pull uses.
     */
    fun localCopy(base: Path?, name: String): Path? {
        base ?: return null
        return listOf(base, base.resolve(name)).firstOrNull { it.fileName?.toString() == name && LocalProject.isProjectDir(it) }
    }

    /** The file to open for a project folder: its __init__.py, else build.as, else null. */
    fun entryFile(dir: Path): Path? = listOf("__init__.py", "build.as").map(dir::resolve).firstOrNull { Files.isRegularFile(it) }
}
