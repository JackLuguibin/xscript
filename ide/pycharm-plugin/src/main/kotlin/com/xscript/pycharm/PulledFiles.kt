package com.xscript.pycharm

import com.intellij.ide.projectView.ProjectView
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VfsUtil
import java.nio.file.Path

/** IDE side of a pull: write the files, then make the VFS, open editors and the project tree show them right away. */
object PulledFiles {
    /**
     * Writes new / changed files, rescans the folder synchronously (call it off the EDT, outside a read action), and asks the
     * project view to rebuild: on its own the tree only noticed a pulled file after several seconds. Returns how many were written.
     */
    fun writeAndRefresh(project: Project, root: Path, pulled: List<ProjectPull.PulledFile>,
                        diff: ProjectPull.Diff = ProjectPull.diff(root, pulled)): Int {
        val written = ProjectPull.write(root, pulled, diff)
        LocalFileSystem.getInstance().refreshAndFindFileByNioFile(root)?.let { VfsUtil.markDirtyAndRefresh(false, true, true, it) }
        ApplicationManager.getApplication().invokeLater({ ProjectView.getInstance(project).refresh() }, project.disposed)
        return written
    }
}
