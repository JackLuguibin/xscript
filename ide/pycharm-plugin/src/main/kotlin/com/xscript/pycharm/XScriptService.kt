package com.xscript.pycharm

import com.intellij.execution.filters.TextConsoleBuilderFactory
import com.intellij.execution.ui.ConsoleView
import com.intellij.execution.ui.ConsoleViewContentType
import com.intellij.notification.NotificationAction
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

    /** Unless `full`, only files new or changed since the last upload from this IDE project are sent. */
    fun uploadAndRun(root: Path, full: Boolean = false) {
        val name = root.fileName.toString()
        object : Task.Backgroundable(project, XScriptBundle.message("task.upload", name), true) {
            override fun run(indicator: ProgressIndicator) {
                withPairing { client ->
                    client.stopIfRunning()?.let { print(XScriptBundle.message("log.stopped", it) + "\n", ConsoleViewContentType.SYSTEM_OUTPUT) }
                    val files = LocalProject.collectFiles(root)
                    val key = UploadPlanner.cacheKey(client.target, name)
                    val props = com.intellij.ide.util.PropertiesComponent.getInstance(project)
                    val syncDeletes = XScriptSettings.get().syncDeletes
                    val remote = if (full && !syncDeletes) null else client.projectFiles(name)
                    val cache: Map<String, String> = if (full) emptyMap() else props.getValue(key)?.let {
                        try { com.google.gson.Gson().fromJson<Map<String, String>>(it, object : com.google.gson.reflect.TypeToken<Map<String, String>>() {}.type) } catch (_: Exception) { null }
                    } ?: emptyMap()
                    val plan = UploadPlanner.plan(files, if (full) null else remote, cache)
                    print(XScriptBundle.message("log.upload", plan.upload.size, name, client.target.baseUrl) +
                        (if (plan.skipped > 0) XScriptBundle.message("log.upload.skipped", plan.skipped) else "") + "\n", ConsoleViewContentType.SYSTEM_OUTPUT)
                    if (plan.upload.isNotEmpty() || remote == null) client.uploadFiles(name, plan.upload)
                    props.setValue(key, com.google.gson.Gson().toJson(plan.hashes))
                    if (syncDeletes) deleteRemoved(client, root, name, files, remote)
                    val since = client.currentSeq()
                    startOrExplain(client, name)
                    lastProject = name
                    showLog()
                    follow(client, since)
                }
            }
        }.queue()
    }

    /** Prints what Upload and Run would send and delete for `root`, touching nothing on the device. */
    fun previewUpload(root: Path) {
        val name = root.fileName.toString()
        object : Task.Backgroundable(project, XScriptBundle.message("task.preview", name), true) {
            override fun run(indicator: ProgressIndicator) {
                withPairing { client ->
                    val files = LocalProject.collectFiles(root)
                    val ignore = LocalProject.loadIgnore(root)
                    val props = com.intellij.ide.util.PropertiesComponent.getInstance(project)
                    val cache: Map<String, String> = props.getValue(UploadPlanner.cacheKey(client.target, name))?.let {
                        try { com.google.gson.Gson().fromJson<Map<String, String>>(it, object : com.google.gson.reflect.TypeToken<Map<String, String>>() {}.type) } catch (_: Exception) { null }
                    } ?: emptyMap()
                    val p = UploadPlanner.preview(files, client.projectFiles(name) ?: emptyList(), cache,
                        { LocalProject.isSyncedPath(it, ignore) }, XScriptSettings.get().syncDeletes)
                    val more: (Int) -> String = { XScriptBundle.message("delete.more", it) }
                    val out = StringBuilder(XScriptBundle.message("preview.title", name)).append('\n')
                    fun section(key: String, paths: List<String>) {
                        if (paths.isEmpty()) return
                        out.append('\n').append(XScriptBundle.message(key, paths.size)).append('\n')
                            .append(UploadPlanner.describeDeletes(paths, more = more)).append('\n')
                    }
                    section("preview.added", p.added)
                    section("preview.changed", p.changed)
                    out.append('\n').append(XScriptBundle.message("preview.unchanged", p.unchanged)).append('\n')
                    section("preview.deletes", p.deletes)
                    section("preview.folders", p.folders.map { "$it/" })
                    section("preview.kept", p.kept)
                    if (!p.hasWork) out.append('\n').append(XScriptBundle.message("preview.upToDate")).append('\n')
                    out.append('\n').append(XScriptBundle.message("preview.footer")).append('\n')
                    print(out.toString(), ConsoleViewContentType.SYSTEM_OUTPUT)
                    showLog()
                    if (p.hasWork) offerUpload(root, name, p)
                }
            }
        }.queue()
    }

    /** After a preview with something to do: a notification whose action runs the same incremental "Upload and Run". */
    private fun offerUpload(root: Path, name: String, p: SyncPreview) {
        val text = XScriptBundle.message("preview.offer", name, p.added.size, p.changed.size) +
            (if (p.deletes.isNotEmpty()) XScriptBundle.message("preview.offerDeletes", p.deletes.size) else "")
        NotificationGroupManager.getInstance().getNotificationGroup("XScript").createNotification(text, NotificationType.INFORMATION)
            .addAction(NotificationAction.createSimpleExpiring(XScriptBundle.message("preview.offerAction")) { uploadAndRun(root) })
            .notify(project)
    }

    /**
     * "Delete files removed locally" (off by default): device files that are not in the local project and that an
     * upload manages (.syncignore'd and skipped paths are never touched) are listed and deleted only when confirmed.
     */
    private fun deleteRemoved(client: DeviceClient, root: Path, name: String, files: List<UploadFile>, remote: List<RemoteFile>?) {
        val ignore = LocalProject.loadIgnore(root)
        val gone = UploadPlanner.planDeletes(files.map { it.path }, remote) { LocalProject.isSyncedPath(it, ignore) }
        if (gone.isEmpty()) return
        val folders = UploadPlanner.planEmptiedFolders(files.map { it.path }, remote, gone)
        var ok = false
        ApplicationManager.getApplication().invokeAndWait {
            var list = UploadPlanner.describeDeletes(gone) { XScriptBundle.message("delete.more", it) }
            if (folders.isNotEmpty()) {
                list += "\n\n" + XScriptBundle.message("delete.folders", folders.size) + "\n" +
                    UploadPlanner.describeDeletes(folders.map { "$it/" }) { XScriptBundle.message("delete.more", it) }
            }
            ok = Messages.showOkCancelDialog(project, XScriptBundle.message("delete.confirm", gone.size, name, list), "XScript",
                XScriptBundle.message("delete.ok", gone.size), XScriptBundle.message("delete.keep"), Messages.getWarningIcon()) == Messages.OK
        }
        if (!ok) {
            print(XScriptBundle.message("log.delete.kept", gone.size) + "\n", ConsoleViewContentType.SYSTEM_OUTPUT)
            return
        }
        val failed = gone.filterNot { p -> try { client.deleteFile(name, p) } catch (_: Exception) { false } }
        // A folder still holding a file that could not be deleted is not empty: leave it.
        val emptied = folders.filter { d -> failed.none { it.startsWith("$d/") } }
        val folderFailed = emptied.filterNot { d -> try { client.deleteFolder(name, d); true } catch (_: Exception) { false } }
        val removed = emptied.size - folderFailed.size
        val allFailed = failed + folderFailed.map { "$it/" }
        print(XScriptBundle.message("log.deleted", gone.size - failed.size) +
            (if (removed == 0) "" else XScriptBundle.message("log.deleted.folders", removed)) +
            (if (allFailed.isEmpty()) "" else XScriptBundle.message("log.delete.failed", allFailed.joinToString(", "))) + "\n",
            ConsoleViewContentType.SYSTEM_OUTPUT)
    }

    /** The device's projects for the Device Projects tab; `done` runs on the EDT (not called when the device can't be reached). */
    fun loadDeviceProjects(done: (List<DeviceProjectRow>) -> Unit) {
        object : Task.Backgroundable(project, XScriptBundle.message("task.projects"), false) {
            override fun run(indicator: ProgressIndicator) {
                withPairing { client ->
                    val rows = DeviceProjects.load(client)
                    ApplicationManager.getApplication().invokeLater({ done(rows) }, project.disposed)
                }
            }
        }.queue()
    }

    /** Starts `name`; the device's "already running" refusal becomes a localized message naming what still runs. */
    private fun startOrExplain(client: DeviceClient, name: String) {
        try {
            client.start(name)
        } catch (e: AlreadyRunningException) {
            throw IllegalStateException(XScriptBundle.message("run.alreadyRunning", e.running.ifEmpty { "?" }), e)
        }
    }

    /** Runs a project already on the device (no upload), restarting whatever runs there, and follows its log. */
    fun runOnDevice(name: String, after: () -> Unit = {}) {
        object : Task.Backgroundable(project, XScriptBundle.message("task.run", name), true) {
            override fun run(indicator: ProgressIndicator) {
                withPairing { client ->
                    client.stopIfRunning()?.let { print(XScriptBundle.message("log.stopped", it) + "\n", ConsoleViewContentType.SYSTEM_OUTPUT) }
                    val since = client.currentSeq()
                    startOrExplain(client, name)
                    lastProject = name
                    print(XScriptBundle.message("log.run", name, client.target.baseUrl) + "\n", ConsoleViewContentType.SYSTEM_OUTPUT)
                    showLog()
                    follow(client, since)
                }
                ApplicationManager.getApplication().invokeLater({ after() }, project.disposed)
            }
        }.queue()
    }

    /** Stops one named device project. */
    fun stopProject(name: String, after: () -> Unit = {}) {
        object : Task.Backgroundable(project, XScriptBundle.message("task.stop"), false) {
            override fun run(indicator: ProgressIndicator) {
                withPairing { client ->
                    client.stop(name)
                    print(XScriptBundle.message("log.stopped", name) + "\n", ConsoleViewContentType.SYSTEM_OUTPUT)
                }
                ApplicationManager.getApplication().invokeLater({ after() }, project.disposed)
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
                    val ms = XScriptSettings.get().evalTimeoutMs
                    val r = client.eval(code, ms.toLong())
                    showLog()
                    print(formatEval(code, r), if (r.ok) ConsoleViewContentType.NORMAL_OUTPUT else ConsoleViewContentType.ERROR_OUTPUT)
                    if (!r.ok && r.error == "timeout") print(XScriptBundle.message("log.evalTimeout", ms) + "\n", ConsoleViewContentType.SYSTEM_OUTPUT)
                }
            }
        }.queue()
    }

    /** Asks which device project to pull (unless `preselected`, from the Device Projects tab) and where, downloads it, confirms overwriting changed files, writes and refreshes. */
    fun pullProject(preselected: String? = null) {
        object : Task.Backgroundable(project, XScriptBundle.message("task.pull.list"), true) {
            override fun run(indicator: ProgressIndicator) {
                withPairing { client ->
                    val names = client.listProjects()
                    if (names.isEmpty()) {
                        notify(XScriptBundle.message("pull.none"), NotificationType.INFORMATION)
                        return@withPairing
                    }
                    var name: String? = null
                    var dest: Path? = null
                    ApplicationManager.getApplication().invokeAndWait {
                        if (preselected != null) {
                            name = preselected
                            dest = pullDestination(preselected)
                            return@invokeAndWait
                        }
                        val combo = com.intellij.openapi.ui.ComboBox(names.toTypedArray())
                        val panel = javax.swing.JPanel(java.awt.BorderLayout(0, 6)).apply {
                            add(javax.swing.JLabel(XScriptBundle.message("pull.pick", client.target.baseUrl)), java.awt.BorderLayout.NORTH)
                            add(combo, java.awt.BorderLayout.CENTER)
                        }
                        val ok = com.intellij.openapi.ui.DialogBuilder(project).title("XScript").centerPanel(panel)
                            .apply { setPreferredFocusComponent(combo) }.showAndGet()
                        val picked = combo.selectedItem as? String
                        if (!ok || picked == null) return@invokeAndWait
                        name = picked
                        dest = pullDestination(picked)
                    }
                    val n = name ?: return@withPairing
                    val d = dest ?: return@withPairing
                    indicator.text = XScriptBundle.message("task.pull", n)
                    val pulled = ProjectPull.fetch(client, n) { indicator.text2 = it }
                    val diff = ProjectPull.diff(d, pulled)
                    if (diff.changed.isNotEmpty()) {
                        var ok = false
                        ApplicationManager.getApplication().invokeAndWait {
                            val shown = diff.changed.take(3).joinToString(", ") + if (diff.changed.size > 3) ", …" else ""
                            ok = Messages.showOkCancelDialog(project, XScriptBundle.message("pull.overwrite", diff.changed.size, shown),
                                "XScript", XScriptBundle.message("pull.overwrite.ok"), Messages.getCancelButton(), Messages.getWarningIcon()) == Messages.OK
                        }
                        if (!ok) return@withPairing
                    }
                    val written = PulledFiles.writeAndRefresh(project, d, pulled, diff)
                    print(XScriptBundle.message("log.pulled", n, d, diff.added.size, diff.changed.size, diff.unchanged.size) + "\n",
                        ConsoleViewContentType.SYSTEM_OUTPUT)
                    notify(XScriptBundle.message("notify.pulled", n, written, d), NotificationType.INFORMATION)
                }
            }
        }.queue()
    }

    /** The IDE project itself or its sub-folder when it is named like the device project and is a project; else a chosen parent folder + name. EDT. */
    /**
     * Opens the pulled copy of device project `name` (its entry file, selected in the Project view);
     * when there is none in this IDE project, offers to pull it. EDT.
     */
    fun openLocalCopy(name: String) {
        val dir = DeviceProjects.localCopy(project.basePath?.let { Path.of(it) }, name)
        if (dir == null) {
            if (Messages.showYesNoDialog(project, XScriptBundle.message("projects.open.none", name), "XScript",
                    XScriptBundle.message("projects.open.pull"), Messages.getCancelButton(), Messages.getQuestionIcon()) == Messages.YES) {
                pullProject(name)
            }
            return
        }
        val target = DeviceProjects.entryFile(dir) ?: dir
        val vf = com.intellij.openapi.vfs.LocalFileSystem.getInstance().refreshAndFindFileByNioFile(target) ?: return
        if (!vf.isDirectory) com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project).openFile(vf, true)
        com.intellij.ide.projectView.ProjectView.getInstance(project).select(null, vf, false)
    }

    private fun pullDestination(name: String): Path? {
        val base = project.basePath?.let { Path.of(it) }
        DeviceProjects.localCopy(base, name)?.let { return it }
        val desc = com.intellij.openapi.fileChooser.FileChooserDescriptorFactory.createSingleFolderDescriptor()
            .withTitle(XScriptBundle.message("pull.dest", name))
        val parent = com.intellij.openapi.fileChooser.FileChooser.chooseFile(desc, project,
            base?.let { com.intellij.openapi.vfs.LocalFileSystem.getInstance().findFileByNioFile(it) }) ?: return null
        return parent.toNioPathOrNull()?.resolve(name)
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

    /** Status bar / Tools menu: ask the phone to show the screen-recording grant dialog. */
    fun requestCapture() {
        object : Task.Backgroundable(project, XScriptBundle.message("task.requestCapture"), true) {
            override fun run(indicator: ProgressIndicator) {
                withPairing { client ->
                    if (client.requestCapture()) {
                        notify(XScriptBundle.message("notify.captureRequested"), NotificationType.INFORMATION)
                    } else {
                        notify(XScriptBundle.message("notify.captureOldApp"), NotificationType.WARNING)
                    }
                }
                refreshStatus()
            }
        }.queue()
    }

    /** Re-checks the status bar's device state now (after a run, stop or connect) instead of at the next poll. */
    fun refreshStatus() {
        ApplicationManager.getApplication().invokeLater({
            val w = com.intellij.openapi.wm.WindowManager.getInstance().getStatusBar(project)
                ?.getWidget(DEVICE_STATUS_WIDGET_ID) as? DeviceStatusWidget ?: return@invokeLater
            ApplicationManager.getApplication().executeOnPooledThread { w.refresh() }
        }, project.disposed)
    }

    /** Runs `body`; on the device's 401 asks for the pairing code once, stores it and retries. Other errors are reported. */
    private fun withPairing(body: (DeviceClient) -> Unit) {
        try {
            withPairingInner(body)
        } finally {
            refreshStatus()
        }
    }

    private fun withPairingInner(body: (DeviceClient) -> Unit) {
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
            if (isUnreachable(e)) {
                val why = XScriptBundle.message("notify.unreachable", settings.target().baseUrl)
                print("$why\n", ConsoleViewContentType.ERROR_OUTPUT)
                notifyRetry(why, XScriptBundle.message("notify.retry"), helpUrl = TROUBLESHOOTING_URL) { withPairing(body) }
                return
            }
            val why = if (e is DeviceHttpException) e.message else e.message ?: e.toString()
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
                val end = followLoop(
                    tick = { followTick(client, state) { print(it) } },
                    alive = { gen == generation.get() && !project.isDisposed },
                    sleep = { Thread.sleep(it) },
                    onLost = { print(XScriptBundle.message("log.reconnecting") + "\n", ConsoleViewContentType.SYSTEM_OUTPUT) },
                    onBack = { print(XScriptBundle.message("log.reconnected") + "\n", ConsoleViewContentType.SYSTEM_OUTPUT) },
                )
                refreshStatus()
                when (end) {
                    FollowEnd.Finished -> print(XScriptBundle.message("log.finished") + "\n", ConsoleViewContentType.SYSTEM_OUTPUT)
                    is FollowEnd.Lost -> {
                        print(XScriptBundle.message("log.lost") + "\n", ConsoleViewContentType.ERROR_OUTPUT)
                        notifyRetry(XScriptBundle.message("log.lost"), XScriptBundle.message("log.resume")) {
                            if (gen == generation.get()) follow(client, state.since)
                        }
                    }
                    FollowEnd.Cancelled -> {}
                }
            } catch (_: InterruptedException) {
            } catch (e: Exception) {
                print(XScriptBundle.message("log.followStopped", e.message ?: e.toString()) + "\n", ConsoleViewContentType.ERROR_OUTPUT)
            }
        }
    }

    /** Error notification with one action button (e.g. retry). */
    private fun notifyRetry(text: String, action: String, helpUrl: String? = null, run: () -> Unit) {
        val n = NotificationGroupManager.getInstance().getNotificationGroup("XScript").createNotification(text, NotificationType.ERROR)
            .addAction(NotificationAction.createSimpleExpiring(action) {
                ApplicationManager.getApplication().executeOnPooledThread { run() }
            })
        if (helpUrl != null) {
            n.addAction(NotificationAction.createSimple(XScriptBundle.message("notify.help")) {
                com.intellij.ide.BrowserUtil.browse(helpUrl)
            })
        }
        n.notify(project)
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
