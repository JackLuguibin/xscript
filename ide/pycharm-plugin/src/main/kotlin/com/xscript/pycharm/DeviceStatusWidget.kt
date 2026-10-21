package com.xscript.pycharm

import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionPlaces
import com.intellij.openapi.actionSystem.ex.ActionUtil
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.util.Consumer
import com.intellij.util.concurrency.AppExecutorUtil
import java.awt.Component
import java.awt.event.MouseEvent
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

const val DEVICE_STATUS_WIDGET_ID = "XScript.DeviceStatus"

class DeviceStatusWidgetFactory : StatusBarWidgetFactory {
    override fun getId() = DEVICE_STATUS_WIDGET_ID
    override fun getDisplayName() = XScriptBundle.message("status.widgetName")
    override fun createWidget(project: Project): StatusBarWidget = DeviceStatusWidget(project)
}

/**
 * "XScript: 已连接 / 运行中 demo / 离线 / 需要配对" in the status bar. Checks /status once at start, then every few seconds
 * while the IDE is the active app and once a minute otherwise (a closed app or an unplugged phone fails at once on the
 * default 127.0.0.1 address, so this is cheap).
 */
class DeviceStatusWidget(private val project: Project) : StatusBarWidget, StatusBarWidget.TextPresentation {
    @Volatile var state: DeviceState = DeviceState.Unknown
        private set
    private var statusBar: StatusBar? = null
    private var poll: ScheduledFuture<*>? = null
    @Volatile private var lastCheck = 0L

    /** Every tick while the IDE is the active app; otherwise once a minute (and always the first time). */
    internal fun shouldPoll(active: Boolean, now: Long) = lastCheck == 0L || active || now - lastCheck >= IDLE_POLL_MS

    override fun ID() = DEVICE_STATUS_WIDGET_ID
    override fun getPresentation() = this

    override fun install(statusBar: StatusBar) {
        this.statusBar = statusBar
        poll = AppExecutorUtil.getAppScheduledExecutorService().scheduleWithFixedDelay({
            if (shouldPoll(ApplicationManager.getApplication().isActive, System.currentTimeMillis())) refresh()
        }, 0, POLL_SECONDS, TimeUnit.SECONDS)
    }

    /** Checks now (background thread) and repaints. */
    fun refresh() {
        if (project.isDisposed) return
        lastCheck = System.currentTimeMillis()
        val next = probe { XScriptSettings.get().client().status(STATUS_TIMEOUT_MS) }
        update(next)
    }

    internal fun update(next: DeviceState) {
        state = next
        ApplicationManager.getApplication().invokeLater({ statusBar?.updateWidget(ID()) }, { project.isDisposed })
    }

    override fun getText() = statusLabel(state)
    override fun getAlignment() = Component.CENTER_ALIGNMENT
    override fun getTooltipText() = statusTooltip(state, XScriptSettings.get().device)

    override fun getClickConsumer() = Consumer<MouseEvent> { e ->
        if (clickOpensConnect(state)) {
            ActionManager.getInstance().getAction("XScript.Connect")?.let {
                ActionUtil.invokeAction(it, e.component, ActionPlaces.STATUS_BAR_PLACE, e, null)
            }
        } else {
            ToolWindowManager.getInstance(project).getToolWindow("XScript")?.show()
        }
        ApplicationManager.getApplication().executeOnPooledThread { refresh() }
    }

    override fun dispose() {
        poll?.cancel(false)
        poll = null
        statusBar = null
    }

    companion object {
        const val POLL_SECONDS = 5L
        const val STATUS_TIMEOUT_MS = 2000L
        const val IDLE_POLL_MS = 60_000L
    }
}
