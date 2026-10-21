package com.xscript.pycharm

import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.module.ModuleManager
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import java.nio.file.Path

/** Turns the bundled completion stubs on or off for every module of the project. */
class ToggleStubsAction : DumbAwareAction() {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val project = e.project
        e.presentation.isEnabled = project != null && Stubs.dir() != null
        e.presentation.text = XScriptBundle.message(
            if (project != null && enabled(project)) "stubs.action.off" else "stubs.action.on")
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        if (enabled(project)) disable(project) else enable(project)
    }

    companion object {
        fun enabled(project: Project): Boolean {
            val dir = Stubs.dir() ?: return false
            return ModuleManager.getInstance(project).modules.any { Stubs.isAttached(it, dir) }
        }

        fun enable(project: Project) {
            val dir = Stubs.dir() ?: return
            ApplicationManager.getApplication().invokeLater({
                ModuleManager.getInstance(project).modules.forEach { Stubs.attach(it, dir) }
                XScriptService.get(project).notify(XScriptBundle.message("stubs.enabled", dir.toString()), NotificationType.INFORMATION)
            }, project.disposed)
        }

        fun disable(project: Project) {
            ApplicationManager.getApplication().invokeLater({
                ModuleManager.getInstance(project).modules.forEach { Stubs.detach(it) }
            }, project.disposed)
        }
    }
}

/**
 * On opening a project that looks like an XScript project (a folder with build.as, or __init__.py importing xscript /
 * ascript, at the top or one level down) without the stubs, offers to add them. It asks; it never changes the project itself.
 */
class StubsStartupActivity : ProjectActivity {
    override suspend fun execute(project: Project) {
        if (ApplicationManager.getApplication().isUnitTestMode) return
        val base = project.basePath?.let { Path.of(it) } ?: return
        if (!looksLikeXScript(base) || Stubs.dir() == null || ToggleStubsAction.enabled(project)) return
        NotificationGroupManager.getInstance().getNotificationGroup("XScript")
            .createNotification(XScriptBundle.message("stubs.offer"), NotificationType.INFORMATION)
            .addAction(NotificationAction.createSimpleExpiring(XScriptBundle.message("stubs.action.on")) { ToggleStubsAction.enable(project) })
            .notify(project)
    }

    companion object {
        fun looksLikeXScript(base: Path): Boolean {
            val dirs = buildList {
                add(base)
                runCatching { java.nio.file.Files.list(base).use { s -> s.filter { java.nio.file.Files.isDirectory(it) }.limit(200).forEach { add(it) } } }
            }
            return dirs.any { d ->
                java.nio.file.Files.exists(d.resolve("build.as")) || runCatching {
                    val init = d.resolve("__init__.py")
                    java.nio.file.Files.size(init) < 1_000_000 &&
                        Regex("^\\s*(from|import)\\s+(xscript|ascript)\\b", RegexOption.MULTILINE).containsMatchIn(java.nio.file.Files.readString(init))
                }.getOrDefault(false)
            }
        }
    }
}
