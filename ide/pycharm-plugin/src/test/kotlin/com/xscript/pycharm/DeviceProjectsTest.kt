package com.xscript.pycharm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.nio.file.Files

class DeviceProjectsTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun localCopyIsTheProjectItselfWhenNamedLikeIt() {
        val base = tmp.newFolder("demo").toPath()
        Files.writeString(base.resolve("__init__.py"), "")
        assertEquals(base, DeviceProjects.localCopy(base, "demo"))
        assertNull(DeviceProjects.localCopy(base, "other"))
    }

    @Test fun localCopyIsASubFolderProject() {
        val base = tmp.newFolder("work").toPath()
        Files.createDirectories(base.resolve("demo"))
        assertNull(DeviceProjects.localCopy(base, "demo"))           // folder without a project marker
        Files.writeString(base.resolve("demo/build.as"), "")
        assertEquals(base.resolve("demo"), DeviceProjects.localCopy(base, "demo"))
        assertNull(DeviceProjects.localCopy(null, "demo"))
    }

    @Test fun entryFilePrefersInitThenBuildAs() {
        val dir = tmp.newFolder("p").toPath()
        assertNull(DeviceProjects.entryFile(dir))
        Files.writeString(dir.resolve("build.as"), "")
        assertEquals(dir.resolve("build.as"), DeviceProjects.entryFile(dir))
        Files.writeString(dir.resolve("__init__.py"), "")
        assertEquals(dir.resolve("__init__.py"), DeviceProjects.entryFile(dir))
    }
}
