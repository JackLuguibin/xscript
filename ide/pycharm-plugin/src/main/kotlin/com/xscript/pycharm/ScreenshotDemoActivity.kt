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
 * Docs screenshots only. With -Dxscript.screenshotDemo=run|settings|eval|pull (set by `./gradlew runIde -PrunIdeScreenshotDemo=…`,
 * never in a normal IDE) it opens the first XScript project's __init__.py and runs Upload and Run (`run`), or opens
 * Settings | Tools | XScript (`settings`), selects the first `_result` line and runs Run Selection on Device (`eval`), or starts
 * Pull Project from Device (`pull`), or runs a device project and opens the Device Projects tab (`projects`), or opens Connect to Device and checks
 * -Dxscript.screenshotConnect (`connect`, `capture`), so screenshots need no scripted mouse clicks. Does nothing otherwise.
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
            if (mode == "pull") {
                XScriptService.get(project).pullProject()
                return@invokeLater
            }
            if (mode == "projects") {
                XScriptService.get(project).runOnDevice("daily_signin")
                return@invokeLater
            }
            if (mode == "capture") {
                // status bar on a device whose screen-recording grant is gone (-Dxscript.screenshotConnect=<address>).
                // A paired device needs its code: XS_SHOT_CODE from the environment, stored only when this sandbox IDE's
                // password safe is memory-only (runIde sets that up for this mode), so it never reaches the system keychain.
                AppExecutorUtil.getAppScheduledExecutorService().schedule({
                    System.getProperty("xscript.screenshotConnect")?.let { XScriptSettings.get().device = it }
                    System.getenv("XS_SHOT_CODE")?.takeIf { it.isNotBlank() }?.let { code ->
                        if (com.intellij.ide.passwordSafe.PasswordSafe.instance.isMemoryOnly) XScriptSettings.get().setPairingCode(code)
                    }
                    XScriptService.get(project).refreshStatus()
                }, 10, TimeUnit.SECONDS)
                return@invokeLater
            }
            if (mode == "connect") {
                // open the dialog a bit later (after the startup tidy-up) and check the address from -Dxscript.screenshotConnect
                AppExecutorUtil.getAppScheduledExecutorService().schedule({
                    app.invokeLater({
                        val dialog = ConnectDialog(project, System.getProperty("xscript.screenshotConnect") ?: "127.0.0.1:1")
                        app.invokeLater({ dialog.check(closeIfOk = false) }, com.intellij.openapi.application.ModalityState.any())
                        dialog.show()
                    }, project.disposed)
                }, 14, TimeUnit.SECONDS)
                return@invokeLater
            }
            ToggleStubsAction.enable(project)
            if (mode == "run") XScriptService.get(project).uploadAndRun(root)
        }, project.disposed)
        // the IDE opens "What's New" and posts its own startup notifications a few seconds later: tidy up for the shot
        AppExecutorUtil.getAppScheduledExecutorService().schedule({
            app.invokeLater({
                val fem = FileEditorManager.getInstance(project)
                fem.openFiles.filter { it != init }.forEach { fem.closeFile(it) }
                init?.let { fem.openFile(it, true) }
                NotificationsManager.getNotificationsManager().getNotificationsOfType(Notification::class.java, project).forEach { it.expire() }
                if (mode == "eval") init?.let { file ->
                    val editor = fem.selectedTextEditor ?: return@let
                    val doc = editor.document
                    val line = (0 until doc.lineCount).firstOrNull {
                        doc.getText(com.intellij.openapi.util.TextRange(doc.getLineStartOffset(it), doc.getLineEndOffset(it))).contains("_result")
                    } ?: return@let
                    editor.selectionModel.setSelection(doc.getLineStartOffset(line), doc.getLineEndOffset(line))
                    editor.caretModel.moveToOffset(doc.getLineEndOffset(line))
                    editor.selectionModel.selectedText?.let { XScriptService.get(project).eval(it) }
                }
                if (mode == "projects") ToolWindowManager.getInstance(project).getToolWindow(XScriptService.TOOL_WINDOW_ID)?.let { tw ->
                    tw.show()
                    tw.contentManager.contents.getOrNull(1)?.let { c ->
                        tw.contentManager.setSelectedContent(c)
                        AppExecutorUtil.getAppScheduledExecutorService().schedule({
                            app.invokeLater({ (c.component as? DeviceProjectsPanel)?.list?.selectedIndex = 0 }, project.disposed)
                        }, 3, TimeUnit.SECONDS)
                    }
                }
                if (mode == "run" || mode == "eval") ToolWindowManager.getInstance(project).getToolWindow(XScriptService.TOOL_WINDOW_ID)?.show()
            }, project.disposed)
        }, 12, TimeUnit.SECONDS)
        // pull: press the project picker's default button so the flow runs to the end (the folder matches the picked name)
        if (mode == "pull") AppExecutorUtil.getAppScheduledExecutorService().schedule({
            app.invokeLater({ shoot(project, "picker"); pressDefaultButton() }, com.intellij.openapi.application.ModalityState.any())
        }, 15, TimeUnit.SECONDS)
        // pull: then confirm the overwrite prompt (shown when a local file differs) and capture the result
        if (mode == "pull") AppExecutorUtil.getAppScheduledExecutorService().schedule({
            app.invokeLater({ shoot(project, "overwrite"); pressDefaultButton() }, com.intellij.openapi.application.ModalityState.any())
        }, 19, TimeUnit.SECONDS)
        AppExecutorUtil.getAppScheduledExecutorService().schedule({
            app.invokeLater({
                if (mode == "pull") {
                    val fem = FileEditorManager.getInstance(project)
                    fem.openFiles.forEach { fem.closeFile(it) }
                    val pulled = Files.list(base).use { st -> st.filter { Files.isDirectory(it) && it != root }.toList() }
                        .firstNotNullOfOrNull { LocalFileSystem.getInstance().refreshAndFindFileByNioFile(it.resolve("__init__.py")) }
                    pulled?.let {
                        fem.openFile(it, true)
                        com.intellij.ide.projectView.ProjectView.getInstance(project).select(null, it, false)
                    }
                    ToolWindowManager.getInstance(project).getToolWindow(XScriptService.TOOL_WINDOW_ID)?.show()
                }
            }, project.disposed)
            AppExecutorUtil.getAppScheduledExecutorService().schedule({
                app.invokeLater({ shoot(project, mode) }, com.intellij.openapi.application.ModalityState.any())
            }, 2, TimeUnit.SECONDS)
        }, 22, TimeUnit.SECONDS)
    }

    /** With -Dxscript.screenshotOut=<dir>: paints the frontmost IDE window (a dialog if one is open) into <dir>/<name>.png. */
    private fun shoot(project: Project, name: String) {
        val dir = System.getProperty("xscript.screenshotOut")?.let { Path.of(it) } ?: return
        val window = java.awt.Window.getWindows().filter { it.isShowing && it is java.awt.Dialog }.lastOrNull()
            ?: com.intellij.openapi.wm.WindowManager.getInstance().getFrame(project) ?: return
        val scale = window.graphicsConfiguration.defaultTransform.scaleX
        val img = java.awt.image.BufferedImage((window.width * scale).toInt(), (window.height * scale).toInt(), java.awt.image.BufferedImage.TYPE_INT_RGB)
        val g = img.createGraphics()
        g.scale(scale, scale)
        window.printAll(g)
        g.dispose()
        Files.createDirectories(dir)
        javax.imageio.ImageIO.write(img, "png", dir.resolve("$name.png").toFile())
    }

    private fun pressDefaultButton() {
        val dialog = java.awt.Window.getWindows().filterIsInstance<javax.swing.JDialog>().lastOrNull { it.isShowing } ?: return
        dialog.rootPane.defaultButton?.doClick()
    }

    companion object {
        fun mode(): String? = System.getProperty("xscript.screenshotDemo")?.takeIf { it in MODES }
        private val MODES = setOf("run", "settings", "eval", "pull", "projects", "connect", "capture")
    }
}
