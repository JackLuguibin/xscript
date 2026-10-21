package com.xscript.app

import android.Manifest
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import android.content.ComponentName
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.graphics.Typeface
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings as AndroidSettings
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import com.xscript.app.a11y.AccessibilityEngine
import com.xscript.app.a11y.XscriptAccessibilityService
import com.xscript.app.capture.CaptureEngine
import com.xscript.app.cloud.CloudClient
import com.xscript.app.http.ClientTracker
import com.xscript.app.http.Pairing
import com.xscript.app.http.DeviceHttpService
import com.xscript.app.net.NetworkInfo
import com.xscript.app.project.ProjectStore
import com.xscript.app.root.RootShell
import com.xscript.app.runtime.RunState
import com.xscript.app.runtime.ScriptService
import com.xscript.app.settings.Settings
import com.xscript.app.ui.FloatControl
import com.xscript.app.ui.HomeModel
import com.xscript.app.ui.LogActivity
import com.xscript.app.ui.ProjectsActivity
import com.xscript.app.ui.UiKit

/** Home screen, laid out like AScript's device page: status rows grouped in cards. */
class MainActivity : AppCompatActivity() {
    private val ui by lazy { UiKit.palette(this) }
    private val handler = Handler(Looper.getMainLooper())
    private val tick = object : Runnable {
        override fun run() {
            refresh()
            handler.postDelayed(this, 1500)
        }
    }

    private lateinit var rowEndpoint: UiKit.Row
    private lateinit var rowAi: UiKit.Row
    private lateinit var rowPair: UiKit.Row
    private lateinit var rowMode: UiKit.Row
    private lateinit var rowLink: UiKit.Row
    private lateinit var rowOverlay: UiKit.Row
    private lateinit var rowFloat: UiKit.Row
    private lateinit var rowA11y: UiKit.Row
    private lateinit var rowRoot: UiKit.Row
    private lateinit var rowCapture: UiKit.Row
    private lateinit var rowCloud: UiKit.Row
    private lateinit var rowProjects: UiKit.Row
    private lateinit var rowNotif: UiKit.Row
    private lateinit var rowStorage: UiKit.Row
    private lateinit var rowBattery: UiKit.Row
    private lateinit var run: UiKit.RunCardViews
    private lateinit var permsHeader: UiKit.Section

    private val notifyPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { DeviceHttpService.start(this) }

    private val capturePermission = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val data = result.data
        if (result.resultCode == CaptureEngine.RESULT_OK && data != null) {
            DeviceHttpService.deliverProjection(this, result.resultCode, data)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        build()
        askCaptureIfRequested(intent)
        if (Build.VERSION.SDK_INT >= 33) {
            notifyPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            DeviceHttpService.start(this)
        }
    }

    private fun build() {
        val col = UiKit.screen(this, getString(R.string.app_name), "Python 自动化 · v" + XscriptApp.versionName(this), back = false)
        UiKit.barAction(col, "日志") { startActivity(Intent(this, LogActivity::class.java)) }

        run = UiKit.runCard(col) { toggleRun() }

        // Grouped by what the user does: open a project, connect a computer, choose how scripts run, grant access.
        val apps = UiKit.card(col)
        rowProjects = UiKit.row(apps, R.drawable.ic_sym_apps, "小程序列表") {
            startActivity(Intent(this, ProjectsActivity::class.java))
        }

        UiKit.section(col, "开发与连接")
        val dev = UiKit.card(col, UiKit.Space.S)
        rowEndpoint = UiKit.row(dev, R.drawable.ic_sym_code, "开发者地址") { endpointTapped() }
        rowPair = UiKit.row(dev, R.drawable.ic_sym_key, "配对码") { showPairing() }
        rowAi = UiKit.row(dev, R.drawable.ic_sym_smart_toy, "AI 编程连接") { showAiHelp() }
        rowCloud = UiKit.row(dev, R.drawable.ic_sym_cloud, "云端控制") { editCloud() }
        rowLink = UiKit.row(dev, R.drawable.ic_sym_link, "链接启动") { chooseLinkMode() }

        UiKit.section(col, "运行设置")
        val run = UiKit.card(col, UiKit.Space.S)
        rowMode = UiKit.row(run, R.drawable.ic_sym_tune, "运行模式") { chooseMode() }
        rowFloat = UiKit.row(run, R.drawable.ic_sym_picture_in_picture, "悬浮窗显示") { FloatControl.chooseMode(this) { refresh() } }

        permsHeader = UiKit.section(col, "权限")
        val perms = UiKit.card(col, UiKit.Space.S)
        rowOverlay = UiKit.row(perms, R.drawable.ic_sym_layers, "悬浮窗权限") { openOverlaySettings() }
        rowA11y = UiKit.row(perms, R.drawable.ic_sym_accessibility_new, "辅助权限管理") {
            startActivity(Intent(AndroidSettings.ACTION_ACCESSIBILITY_SETTINGS))
        }
        rowRoot = UiKit.row(perms, R.drawable.ic_sym_terminal, "Root 权限") { requestRoot() }
        rowCapture = UiKit.row(perms, R.drawable.ic_sym_screenshot_monitor, "图色权限") { requestCapture() }
        rowNotif = UiKit.row(perms, R.drawable.ic_sym_notifications, "通知使用权") {
            startActivity(Intent(AndroidSettings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }
        rowStorage = UiKit.row(perms, R.drawable.ic_sym_folder, "文件访问权限") { requestStorage() }
        rowBattery = UiKit.row(perms, R.drawable.ic_sym_battery_saver, "后台运行") { requestBattery() }

        UiKit.section(col, "系统")
        val sys = UiKit.card(col, UiKit.Space.S)
        UiKit.row(sys, R.drawable.ic_sym_developer_mode, "开发者选项") {
            startActivity(Intent(AndroidSettings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS))
        }

        UiKit.note(col, "USB 调试：adb forward tcp:<端口> tcp:<端口>（端口见“开发者地址”，默认 9860，与 AScript 的 9096 互不冲突），然后在电脑上连接 127.0.0.1:<端口>。首次连接需要输入“配对码”。")
    }

    override fun onResume() {
        super.onResume()
        RootShell.probeAsync()
        handler.post(tick)
    }

    override fun onPause() {
        handler.removeCallbacks(tick)
        super.onPause()
    }

    private fun refresh() {
        val e = HomeModel.endpoint(NetworkInfo.server, NetworkInfo.localIp(this), NetworkInfo.PORT)
        endpoint = e
        rowEndpoint.value(e.value, if (e.warn) ui.danger else ui.muted)
        if (Pairing.required) rowPair.value(Pairing.display()) else rowPair.value("已关闭（任何人可连接）", ui.danger)
        val ai = ClientTracker.active()
        if (ai != null) rowAi.value("已连接", ui.success) else rowAi.value("未连接")
        rowMode.value(Settings.runModeLabel())
        rowLink.value(Settings.schemeModeLabel())

        val overlay = FloatControl.canShow(this)
        rowOverlay.value(if (overlay) "已授权" else "未授权，点此开启", if (overlay) ui.success else ui.danger)
        rowFloat.value(FloatControl.modeSummary(this))

        val a11y = AccessibilityEngine.isOn()
        val listed = a11y || isAccessibilityListed()
        rowA11y.value(
            when {
                a11y -> "已开启"
                listed -> "已开启(未连接)"
                else -> "未开启"
            },
            if (a11y) ui.success else ui.danger,
        )

        when (RootShell.known()) {
            true -> rowRoot.value("已获取", ui.success)
            false -> rowRoot.value("未获取")
            null -> rowRoot.value("检测中")
        }

        val cap = CaptureEngine.sourceLabel()
        val capOk = CaptureEngine.available() && !CaptureEngine.lost
        rowCapture.value(cap, if (capOk) ui.success else ui.danger)

        val cloud = CloudClient.label()
        rowCloud.value(cloud, if (CloudClient.state == CloudClient.State.CONNECTED) ui.success else ui.muted)

        rowProjects.value("${ProjectStore(this).list().size} 个")
        val notif = hasNotificationAccess()
        rowNotif.value(if (notif) "已授权" else "未授权", if (notif) ui.success else ui.muted)
        rowStorage.value(if (hasStorage()) "已授权" else "未授权", if (hasStorage()) ui.success else ui.muted)
        rowBattery.value(if (isIgnoringBattery()) "不受限" else "受限", if (isIgnoringBattery()) ui.success else ui.muted)

        var granted = 0
        for (on in listOf(overlay, a11y, RootShell.known() == true, CaptureEngine.available(), notif, hasStorage(), isIgnoringBattery())) {
            if (on) granted++
        }
        UiKit.setText(permsHeader.value, HomeModel.permissionSummary(granted, 7))

        val running = RunState.current(this)
        val last = if (running == null) Settings.lastProject.takeIf { ProjectStore(this).exists(it) } else null
        val card = HomeModel.runCard(running, last)
        UiKit.showRunCard(run, card)
    }

    private fun toggleRun() {
        if (RunState.current(this) != null) {
            ScriptService.stop(this)
            return
        }
        val last = Settings.lastProject
        if (last.isEmpty() || !ProjectStore(this).exists(last)) {
            startActivity(Intent(this, ProjectsActivity::class.java))
            return
        }
        ScriptService.run(this, last)
        UiKit.toast(this, "启动 $last")
    }

    private var endpoint: HomeModel.Endpoint? = null

    /** 开发者地址: copy when the server runs; otherwise start it, or retry the ports. */
    private fun endpointTapped() {
        val e = endpoint ?: return copyEndpoint()
        when (e.tap) {
            HomeModel.Tap.COPY -> { copyEndpoint(); e.hint?.let { UiKit.toast(this, it, long = true) } }
            HomeModel.Tap.USB_HELP -> MaterialAlertDialogBuilder(this)
                .setTitle("仅 USB 可连接")
                .setMessage(e.hint)
                .setPositiveButton("复制命令") { _, _ ->
                    val cmd = HomeModel.forwardCommand(NetworkInfo.PORT)
                    (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("adb", cmd))
                    UiKit.toast(this, "已复制 $cmd")
                }
                .setNegativeButton("知道了", null)
                .show()
            HomeModel.Tap.START -> { DeviceHttpService.start(this); UiKit.toast(this, "正在启动服务…") }
            HomeModel.Tap.RETRY -> { DeviceHttpService.restart(this); UiKit.toast(this, e.hint ?: "正在重试…", long = true) }
            HomeModel.Tap.NONE -> Unit
        }
    }

    private fun copyEndpoint() {
        val url = "http://${NetworkInfo.localIp(this)}:${NetworkInfo.PORT}/"
        (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("xscript", url))
        UiKit.toast(this, "已复制 $url")
    }

    private fun showPairing() {
        val ctx = this
        val code = TextView(ctx).apply {
            text = if (Pairing.required) Pairing.display() else "——"
            textSize = UiKit.Type.CODE
            typeface = android.graphics.Typeface.MONOSPACE
            letterSpacing = 0.12f
            gravity = android.view.Gravity.CENTER
            setTextIsSelectable(true)
            setPadding(0, UiKit.dp(ctx, UiKit.Space.S), 0, UiKit.dp(ctx, UiKit.Space.S))
        }
        val toggle = com.google.android.material.materialswitch.MaterialSwitch(ctx).apply {
            text = "需要配对码"
            isChecked = Pairing.required
        }
        val box = UiKit.dialogField(ctx, code, toggle)
        val ip = NetworkInfo.localIp(ctx)
        val dialog = MaterialAlertDialogBuilder(ctx)
            .setTitle("配对码")
            .setMessage(
                "电脑端（桌面客户端、VS Code、MCP、浏览器开发工具）首次连接时输入此配对码。" +
                    "USB 连接的桌面客户端会自动配对。\n\n浏览器打开 http://$ip:${NetworkInfo.PORT}/ 后按提示输入。",
            )
            .setView(box)
            .setPositiveButton("复制配对码") { _, _ ->
                (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("xscript", Pairing.display()))
                UiKit.toast(ctx, "已复制配对码")
            }
            .setNeutralButton("重新生成") { _, _ ->
                MaterialAlertDialogBuilder(ctx)
                    .setTitle("重新生成配对码？")
                    .setMessage("所有已配对的电脑和浏览器都需要用新配对码重新配对。")
                    .setPositiveButton("重新生成") { _, _ ->
                        Pairing.regenerate()
                        refresh()
                        showPairing()
                    }
                    .setNegativeButton("取消", null)
                    .show()
            }
            .setNegativeButton("关闭", null)
            .show()
        toggle.setOnCheckedChangeListener { sw, on ->
            if (on) {
                Pairing.required = true
                code.text = Pairing.display()
                refresh()
                return@setOnCheckedChangeListener
            }
            MaterialAlertDialogBuilder(ctx)
                .setTitle("关闭配对？")
                .setMessage("关闭后与 AScript 一样不需要配对码：同一网络中的任何设备或网页都能在手机上运行代码、读写文件。只在可信网络中关闭。")
                .setPositiveButton("仍然关闭") { _, _ ->
                    Pairing.required = false
                    code.text = "——"
                    refresh()
                }
                .setNegativeButton("取消") { _, _ -> sw.isChecked = true }
                .setOnCancelListener { sw.isChecked = true }
                .show()
        }
        dialog.setOnDismissListener { refresh() }
    }

    private fun showAiHelp() {
        val ip = NetworkInfo.localIp(this)
        val who = ClientTracker.active()
        MaterialAlertDialogBuilder(this)
            .setTitle("AI 编程连接")
            .setMessage(
                (if (who != null) "当前连接：$who\n\n" else "") +
                    "在 Cursor 中配置 xscript-mcp，设置：\nXSCRIPT_DEVICE=$ip:${NetworkInfo.PORT}\n" +
                    (if (Pairing.required) "XSCRIPT_TOKEN=${Pairing.display()}\n\n" else "\n") +
                    "USB 连接时执行 adb forward tcp:${NetworkInfo.PORT} tcp:${NetworkInfo.PORT}，并使用 127.0.0.1:${NetworkInfo.PORT}。",
            )
            .setPositiveButton("好", null)
            .show()
    }

    private fun chooseLinkMode() {
        val modes = arrayOf(com.xscript.app.link.SchemeLink.MODE_CONFIRM, com.xscript.app.link.SchemeLink.MODE_ALLOW, com.xscript.app.link.SchemeLink.MODE_OFF)
        MaterialAlertDialogBuilder(this)
            .setTitle("链接启动（xscript://run?name=…）")
            .setSingleChoiceItems(modes.map { Settings.schemeModeLabel(it) }.toTypedArray(), modes.indexOf(Settings.schemeMode)) { d, which ->
                Settings.schemeMode = modes[which]
                d.dismiss()
                refresh()
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun chooseMode() {
        val modes = arrayOf(Settings.MODE_AUTO, Settings.MODE_ACCESSIBILITY, Settings.MODE_ROOT)
        val labels = modes.map { Settings.runModeLabel(it) }.toTypedArray()
        MaterialAlertDialogBuilder(this)
            .setTitle("运行模式")
            .setSingleChoiceItems(labels, modes.indexOf(Settings.runMode)) { d, which ->
                Settings.runMode = modes[which]
                if (modes[which] == Settings.MODE_ROOT) RootShell.probeAsync()
                d.dismiss()
                refresh()
            }
            .show()
    }

    private fun openOverlaySettings() {
        startActivity(FloatControl.permissionIntent(this))
    }

    private fun requestRoot() {
        RootShell.probeAsync { ok ->
            runOnUiThread {
                UiKit.toast(this, if (ok) "已获取 Root" else "未获取 Root")
                refresh()
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        askCaptureIfRequested(intent)
    }

    /** Opened from the "图色权限已失效" notification: ask for the grant right away. */
    private fun askCaptureIfRequested(intent: Intent?) {
        if (intent?.getBooleanExtra(com.xscript.app.capture.CaptureNotice.EXTRA_REQUEST_CAPTURE, false) != true) return
        intent.removeExtra(com.xscript.app.capture.CaptureNotice.EXTRA_REQUEST_CAPTURE)
        requestCapture()
    }

    private fun requestCapture() {
        val mgr = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        capturePermission.launch(mgr.createScreenCaptureIntent())
    }

    private fun editCloud() {
        val input = EditText(this).apply {
            setText(Settings.cloudUrl)
            hint = "wss://example.com/device?token=..."
            isSingleLine = true
        }
        val box = UiKit.dialogField(this, input)
        MaterialAlertDialogBuilder(this)
            .setTitle("云端控制")
            .setMessage("设备主动连接控制服务器的 WebSocket，服务器即可远程调用与局域网相同的接口。" +
                if (CloudClient.lastError.isNotEmpty()) "\n\n最近错误：${CloudClient.lastError}" else "")
            .setView(box)
            .setPositiveButton("连接") { _, _ ->
                try {
                    CloudClient.connect(this, input.text.toString())
                } catch (e: Exception) {
                    UiKit.toast(this, e.message, long = true)
                }
            }
            .setNeutralButton("断开") { _, _ -> CloudClient.forget() }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun hasStorage(): Boolean =
        if (Build.VERSION.SDK_INT >= 30) Environment.isExternalStorageManager() else true

    private fun requestStorage() {
        if (Build.VERSION.SDK_INT >= 30) {
            try {
                startActivity(Intent(AndroidSettings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:$packageName")))
            } catch (_: Exception) {
                startActivity(Intent(AndroidSettings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
            }
        }
    }

    private fun requestBattery() {
        startActivity(
            Intent(AndroidSettings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:$packageName")
            },
        )
    }

    private fun isAccessibilityListed(): Boolean {
        val expected = ComponentName(this, XscriptAccessibilityService::class.java).flattenToString()
        val enabled = AndroidSettings.Secure.getString(
            contentResolver,
            AndroidSettings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
        ) ?: return false
        return enabled.split(':').any { it.equals(expected, ignoreCase = true) }
    }

    private fun hasNotificationAccess(): Boolean =
        androidx.core.app.NotificationManagerCompat.getEnabledListenerPackages(this).contains(packageName)

    private fun isIgnoringBattery(): Boolean {
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        return pm.isIgnoringBatteryOptimizations(packageName)
    }
}
