package com.xscript.pycharm

import com.intellij.notification.Notification
import com.intellij.notification.NotificationsManager
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.util.concurrency.AppExecutorUtil
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.TimeUnit

/**
 * Docs screenshots only. With -Dxscript.screenshotDemo=run|settings (set by `./gradlew runIde -PrunIdeScreenshotDemo=…`,
 * never in a normal IDE) it opens the first XScript project's __init__.py and runs Upload and Run (`run`), or opens
 * Settings | Tools | XScript (`settings`), so screenshots need no scripted mouse clicks. Does nothing otherwise.
 */
class ScreenshotDemoActivity : ProjectActivity {
    override suspend fun execute(project: Project) {
        val mode = mode() ?: return
        val base = project.basePath?.let { Path.of(it) } ?: return
        val root = (listOf(base) + Files.list(base).use { s -> s.filter { Files.isDirectory(it) }.toList() })
            .firstOrNull { LocalProject.isProjectDir(it) } ?: return
        val init = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(root.resolve("__init__.py")) // off the EDT
        val app = ApplicationManager.getApplication()
        app.invokeLater({
            if (mode == "settings") {
                ShowSettingsUtil.getInstance().showSettingsDialog(project, XScriptConfigurable::class.java)
                return@invokeLater
            }
            ToggleStubsAction.enable(project)
            XScriptService.get(project).uploadAndRun(root)
        }, project.disposed)
        // the IDE opens "What's New" and posts its own startup notifications a few seconds later: tidy up for the shot
        AppExecutorUtil.getAppScheduledExecutorService().schedule({
            app.invokeLater({
                val fem = FileEditorManager.getInstance(project)
                fem.openFiles.filter { it != init }.forEach { fem.closeFile(it) }
                init?.let { fem.openFile(it, true) }
                NotificationsManager.getNotificationsManager().getNotificationsOfType(Notification::class.java, project).forEach { it.expire() }
                if (mode == "run") ToolWindowManager.getInstance(project).getToolWindow(XScriptService.TOOL_WINDOW_ID)?.show()
            }, project.disposed)
        }, 12, TimeUnit.SECONDS)
    }

    companion object {
        fun mode(): String? = System.getProperty("xscript.screenshotDemo")?.takeIf { it == "run" || it == "settings" }
    }
}
