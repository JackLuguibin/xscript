package com.xscript.pycharm

import com.intellij.execution.filters.TextConsoleBuilderFactory
import com.intellij.execution.ui.ConsoleView
import com.intellij.execution.ui.ConsoleViewContentType
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.wm.ToolWindowManager
import java.nio.file.Path
import java.util.concurrent.Future
import java.util.concurrent.atomic.AtomicInteger

/** Per IDE project: the XScript log console, the remembered device project and the log follower. */
@Service(Service.Level.PROJECT)
class XScriptService(private val project: Project) : Disposable {
    @Volatile var lastProject: String? = null
        private set
    private var console: ConsoleView? = null
    @Volatile private var follower: Future<*>? = null
    private val generation = AtomicInteger()

    fun console(): ConsoleView = console ?: TextConsoleBuilderFactory.getInstance().createBuilder(project).console.also {
        console = it
        Disposer.register(this, it)
    }

    fun print(text: String, type: ConsoleViewContentType = ConsoleViewContentType.NORMAL_OUTPUT) {
        ApplicationManager.getApplication().invokeLater({ console().print(text, type) }, project.disposed)
    }

    private fun showLog() {
        ApplicationManager.getApplication().invokeLater({
            ToolWindowManager.getInstance(project).getToolWindow(TOOL_WINDOW_ID)?.show()
        }, project.disposed)
    }

    /** Project root for an editor file or selection: the topmost folder with __init__.py / build.as, within the IDE project. */
    fun projectRoot(file: VirtualFile?): Path? {
        val base = project.basePath?.let { Path.of(it) }
        val start = file?.toNioPathOrNull() ?: base ?: return null
        return LocalProject.findRoot(start, base) ?: base?.takeIf { LocalProject.isProjectDir(it) }
    }

    fun uploadAndRun(root: Path) {
        val name = root.fileName.toString()
        object : Task.Backgroundable(project, XScriptBundle.message("task.upload", name), true) {
            override fun run(indicator: ProgressIndicator) {
                withPairing { client ->
                    client.stopIfRunning()?.let { print(XScriptBundle.message("log.stopped", it) + "\n", ConsoleViewContentType.SYSTEM_OUTPUT) }
                    val files = LocalProject.collectFiles(root)
                    print(XScriptBundle.message("log.upload", files.size, name, client.target.baseUrl) + "\n", ConsoleViewContentType.SYSTEM_OUTPUT)
                    client.uploadFiles(name, files)
                    val since = client.currentSeq()
                    val r = client.run(name)
                    r.get("error")?.let { throw IllegalStateException(it.asString) }
                    lastProject = name
                    showLog()
                    follow(client, since)
                }
            }
        }.queue()
    }

    fun stop() {
        val name = lastProject ?: run {
            // nothing started from here: stop whatever the device runs
            null
        }
        object : Task.Backgroundable(project, XScriptBundle.message("task.stop"), false) {
            override fun run(indicator: ProgressIndicator) {
                withPairing { client ->
                    val target = name ?: client.status().get("project")?.takeIf { !it.isJsonNull }?.asString
                    if (target == null) {
                        notify(XScriptBundle.message("notify.notRunning"), NotificationType.INFORMATION)
                        return@withPairing
                    }
                    client.stop(target)
                    print(XScriptBundle.message("log.stopped", target) + "\n", ConsoleViewContentType.SYSTEM_OUTPUT)
                }
            }
        }.queue()
    }

    /** Runs a snippet in the device's eval process and prints it with its result in the XScript console. */
    fun eval(code: String) {
        object : Task.Backgroundable(project, XScriptBundle.message("task.eval"), true) {
            override fun run(indicator: ProgressIndicator) {
                withPairing { client ->
                    val r = client.eval(code)
                    showLog()
                    print(formatEval(code, r), if (r.ok) ConsoleViewContentType.NORMAL_OUTPUT else ConsoleViewContentType.ERROR_OUTPUT)
                }
            }
        }.queue()
    }

    fun testConnection() {
        object : Task.Backgroundable(project, XScriptBundle.message("task.connect"), true) {
            override fun run(indicator: ProgressIndicator) {
                withPairing { client ->
                    val s = client.status(5000)
                    val version = s.get("version")?.takeIf { !it.isJsonNull }?.asString ?: "?"
                    notify(XScriptBundle.message("notify.connected", client.target.baseUrl, version), NotificationType.INFORMATION)
                }
            }
        }.queue()
    }

    /** Runs `body`; on the device's 401 asks for the pairing code once, stores it and retries. Other errors are reported. */
    private fun withPairing(body: (DeviceClient) -> Unit) {
        val settings = XScriptSettings.get()
        try {
            try {
                body(settings.client())
            } catch (e: DeviceHttpException) {
                if (!e.isPairing) throw e
                val code = askCode(settings.target()) ?: return
                settings.setPairingCode(code)
                body(settings.client())
            }
        } catch (e: Exception) {
            val why = when (e) {
                is DeviceHttpException -> e.message
                is java.net.ConnectException, is java.net.http.HttpConnectTimeoutException ->
                    XScriptBundle.message("notify.unreachable", settings.target().baseUrl)
                else -> e.message ?: e.toString()
            }
            print("$why\n", ConsoleViewContentType.ERROR_OUTPUT)
            notify(why ?: "error", NotificationType.ERROR)
        }
    }

    private fun askCode(t: DeviceTarget): String? {
        var result: String? = null
        ApplicationManager.getApplication().invokeAndWait {
            result = Messages.showInputDialog(project, XScriptBundle.message("pair.prompt", "${t.host}:${t.port}"),
                XScriptBundle.message("pair.title"), null, "", object : com.intellij.openapi.ui.InputValidator {
                    override fun checkInput(s: String?) = validateCode(s) == null
                    override fun canClose(s: String?) = validateCode(s) == null
                })
        }
        return result
    }

    private fun follow(client: DeviceClient, since: Long) {
        val gen = generation.incrementAndGet()
        follower?.cancel(true)
        follower = ApplicationManager.getApplication().executeOnPooledThread {
            val state = FollowState(since)
            try {
                while (gen == generation.get() && !project.isDisposed) {
                    if (!followTick(client, state) { print(it) }) {
                        print(XScriptBundle.message("log.finished") + "\n", ConsoleViewContentType.SYSTEM_OUTPUT)
                        break
                    }
                    Thread.sleep(700)
                }
            } catch (_: InterruptedException) {
            } catch (e: Exception) {
                print(XScriptBundle.message("log.followStopped", e.message ?: e.toString()) + "\n", ConsoleViewContentType.ERROR_OUTPUT)
            }
        }
    }

    fun notify(text: String, type: NotificationType) {
        NotificationGroupManager.getInstance().getNotificationGroup("XScript").createNotification(text, type).notify(project)
    }

    override fun dispose() {
        generation.incrementAndGet()
        follower?.cancel(true)
    }

    companion object {
        const val TOOL_WINDOW_ID = "XScript"
        fun get(project: Project): XScriptService = project.getService(XScriptService::class.java)
    }
}

private fun VirtualFile.toNioPathOrNull(): Path? = try { toNioPath() } catch (_: UnsupportedOperationException) { null }
