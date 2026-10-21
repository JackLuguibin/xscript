package com.xscript.pycharm

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.nio.file.Files

/** After a pull the IDE already knows the new files and open documents show the new text, without any further refresh. */
class PulledFilesTest : BasePlatformTestCase() {
    fun testPulledFilesAreVisibleToTheIdeImmediately() {
        val root = Files.createTempDirectory("xs-pulled-")
        com.intellij.openapi.vfs.newvfs.impl.VfsRootAccess.allowRootAccess(testRootDisposable, root.toRealPath().toString())
        try {
            Files.writeString(root.resolve("__init__.py"), "print('old')\n")
            val lfs = LocalFileSystem.getInstance()
            val init = lfs.refreshAndFindFileByNioFile(root.resolve("__init__.py"))!!
            val doc = FileDocumentManager.getInstance().getDocument(init)!!   // like an open editor
            assertEquals("print('old')\n", doc.text)
            assertNull(lfs.findFileByNioFile(root.resolve("config.json")))

            val pulled = listOf(
                ProjectPull.PulledFile("__init__.py", "print('new')\n".toByteArray()),
                ProjectPull.PulledFile("config.json", "{}\n".toByteArray()),
                ProjectPull.PulledFile("lib/a.py", "A = 1\n".toByteArray()),
            )
            var written = 0
            // the pull runs in a background task; its synchronous refresh needs the EDT (this thread), so keep pumping events
            val f = ApplicationManager.getApplication().executeOnPooledThread { written = PulledFiles.writeAndRefresh(project, root, pulled) }
            com.intellij.testFramework.PlatformTestUtil.waitForFuture(f, 30_000)
            assertEquals(3, written)
            // no refresh here: the pull itself must have made them known
            assertNotNull(lfs.findFileByNioFile(root.resolve("config.json")))
            assertNotNull(lfs.findFileByNioFile(root.resolve("lib/a.py")))
            assertEquals("print('new')\n", FileDocumentManager.getInstance().getDocument(init)!!.text)
        } finally {
            root.toFile().deleteRecursively()
        }
    }
}
