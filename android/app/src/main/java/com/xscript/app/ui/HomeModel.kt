package com.xscript.app.ui

import com.xscript.app.net.NetworkInfo
import com.xscript.app.net.NetworkInfo.Server

/** What the home screen shows, kept free of views so the JVM tests cover it. */
object HomeModel {
    /** The run card: the project it is about, its status line and the primary action. */
    data class RunCard(
        val title: String,
        val status: String,
        val action: String,
        val tone: UiKit.Tone,
        val running: Boolean,
        /** Something blocks a run (the status dot turns red). */
        val warn: Boolean = false,
    )

    /**
     * [running] is the project running now, [last] the last one run if it still exists. With neither, the action
     * opens the project list ("选择"), not a green "运行" that has nothing to run.
     */
    fun runCard(running: String?, last: String?): RunCard = when {
        running != null -> RunCard(running, "运行中", "停止", UiKit.Tone.DANGER, true)
        last != null -> RunCard(last, "上次运行 · 可在小程序列表切换", "运行", UiKit.Tone.SUCCESS, false)
        else -> RunCard("还没有选择小程序", "新建、导入或选择一个小程序后即可运行", "选择", UiKit.Tone.PRIMARY, false)
    }

    /**
     * The banner under the run card when nothing can drive the screen: accessibility is off and there is no root.
     * [listed]: the service is switched on in Settings but not connected (common right after a reinstall).
     * Null hides the banner.
     */
    fun a11yBanner(on: Boolean, listed: Boolean, root: Boolean?): String? = when {
        on || root == true -> null
        listed -> "无障碍服务已开启但没连上（重装后常见），需在设置里关掉再打开"
        else -> "无障碍服务未开启，找控件、点击等自动化用不了"
    }

    /** 运行 on the home screen: run right away, or open the project page to fix [missing] permissions first. */
    enum class HomeRun { RUN, ASK }

    fun runFromHome(missing: Int): HomeRun = if (missing > 0) HomeRun.ASK else HomeRun.RUN

    /** Trailing text of the permissions section header. */
    fun permissionSummary(granted: Int, total: Int): String =
        if (granted >= total) "全部已开启" else "已开启 $granted/$total"

    /** The 开发者地址 row: value text, whether it is a problem (red), and what tapping it does. */
    data class Endpoint(val value: String, val warn: Boolean, val tap: Tap, val hint: String? = null)

    /** USB_HELP: a dialog with the adb forward command (a toast hid behind Android's clipboard preview). */
    enum class Tap { COPY, USB_HELP, START, RETRY, NONE }

    fun forwardCommand(port: Int) = "adb forward tcp:$port tcp:$port"

    /** [server] is the HTTP server's state, [ip] the phone's address (127.0.0.1 when it has no network), [port] the bound port. */
    fun endpoint(server: Server, ip: String, port: Int): Endpoint {
        return when (server) {
            Server.RUNNING ->
                if (NetworkInfo.isLoopback(ip)) {
                    Endpoint("127.0.0.1:$port（仅 USB）", true, Tap.USB_HELP,
                        "手机没有连接 Wi-Fi，电脑只能通过 USB 连接。在电脑上执行：\n\n${forwardCommand(port)}\n\n" +
                            "然后用 http://127.0.0.1:$port/ 访问。")
                } else {
                    Endpoint("http://$ip:$port/", false, Tap.COPY)
                }
            Server.NO_FREE_PORT -> Endpoint("端口 ${NetworkInfo.DEFAULT_PORT}–${NetworkInfo.MAX_PORT} 都被占用，点此重试", true, Tap.RETRY,
                "关闭占用这些端口的应用（例如另一个 XScript 打包应用）后重试")
            Server.DISABLED -> Endpoint("开发者服务已关闭", false, Tap.NONE)
            Server.STARTING -> Endpoint("正在启动…", false, Tap.NONE)
            Server.NOT_STARTED -> Endpoint("服务未启动，点此启动", true, Tap.START)
        }
    }
}
