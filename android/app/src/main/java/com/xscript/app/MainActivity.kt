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
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import com.xscript.app.a11y.AccessibilityEngine
import com.xscript.app.a11y.XscriptAccessibilityService
import com.xscript.app.capture.CaptureEngine
import com.xscript.app.cloud.CloudClient
import com.xscript.app.http.ClientTracker
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
    private lateinit var runTitle: TextView
    private lateinit var runSub: TextView
    private lateinit var runButton: TextView
    private lateinit var runDot: View
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
        if (Build.VERSION.SDK_INT >= 33) {
            notifyPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            DeviceHttpService.start(this)
        }
    }

    private fun build() {
        val col = UiKit.screen(this, getString(R.string.app_name), "Python 自动化 · v" + XscriptApp.versionName(this), back = false)
        UiKit.barAction(col, "日志") { startActivity(Intent(this, LogActivity::class.java)) }

        buildRunCard(col)

        // Grouped by what the user does: open a project, connect a computer, choose how scripts run, grant access.
        val apps = UiKit.card(col)
        rowProjects = UiKit.row(apps, R.drawable.ic_sym_apps, "小程序列表") {
            startActivity(Intent(this, ProjectsActivity::class.java))
        }

        UiKit.section(col, "开发与连接")
        val dev = UiKit.card(col, 8f)
        rowEndpoint = UiKit.row(dev, R.drawable.ic_sym_code, "开发者地址") { copyEndpoint() }
        rowAi = UiKit.row(dev, R.drawable.ic_sym_smart_toy, "AI 编程连接") { showAiHelp() }
        rowCloud = UiKit.row(dev, R.drawable.ic_sym_cloud, "云端控制") { editCloud() }
        rowLink = UiKit.row(dev, R.drawable.ic_sym_link, "链接启动") { chooseLinkMode() }

        UiKit.section(col, "运行设置")
        val run = UiKit.card(col, 8f)
        rowMode = UiKit.row(run, R.drawable.ic_sym_tune, "运行模式") { chooseMode() }
        rowFloat = UiKit.row(run, R.drawable.ic_sym_picture_in_picture, "悬浮窗显示") { FloatControl.chooseMode(this) { refresh() } }

        permsHeader = UiKit.section(col, "权限")
        val perms = UiKit.card(col, 8f)
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
        val sys = UiKit.card(col, 8f)
        UiKit.row(sys, R.drawable.ic_sym_developer_mode, "开发者选项") {
            startActivity(Intent(AndroidSettings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS))
        }

        UiKit.note(col, "USB 调试：adb forward tcp:<端口> tcp:<端口>（端口见“开发者地址”，默认 9860，与 AScript 的 9096 互不冲突），然后在电脑上连接 127.0.0.1:<端口>。")
    }

    private fun buildRunCard(col: LinearLayout) {
        val card = UiKit.card(col)
        val line = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            val p = UiKit.dp(this@MainActivity, 16f)
            setPadding(UiKit.dp(this@MainActivity, 20f), p, p, p)
            minimumHeight = UiKit.dp(this@MainActivity, 88f)
        }
        val texts = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        runTitle = TextView(this).apply {
            textSize = 18f
            setTextColor(ui.text)
            setTypeface(typeface, Typeface.BOLD)
            maxLines = 2
            ellipsize = android.text.TextUtils.TruncateAt.END
        }
        val status = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, UiKit.dp(this@MainActivity, 4f), 0, 0)
        }
        val d = UiKit.dp(this, 8f)
        runDot = UiKit.dot(this, ui.muted)
        status.addView(runDot, LinearLayout.LayoutParams(d, d).apply { rightMargin = UiKit.dp(this@MainActivity, 6f) })
        runSub = TextView(this).apply {
            textSize = 13f
            setTextColor(ui.muted)
        }
        status.addView(runSub, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        texts.addView(runTitle)
        texts.addView(status)
        line.addView(texts, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
            rightMargin = UiKit.dp(this@MainActivity, 12f)
        })
        runButton = UiKit.button(this, "运行", UiKit.Tone.SUCCESS) { toggleRun() }
        line.addView(runButton)
        card.addView(line)
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
        val ip = NetworkInfo.localIp(this)
        rowEndpoint.value("http://$ip:${NetworkInfo.PORT}/")
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
        rowCapture.value(cap, if (CaptureEngine.available()) ui.success else ui.danger)

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
        UiKit.setText(runTitle, card.title)
        UiKit.setText(runSub, card.status)
        UiKit.setText(runButton, card.action)
        // paint and dotColor skip an unchanged tone: a new drawable each tick would redraw the idle screen.
        UiKit.paint(runButton, card.tone)
        UiKit.dotColor(runDot, if (card.running) ui.success else ui.muted)
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
        Toast.makeText(this, "启动 $last", Toast.LENGTH_SHORT).show()
    }

    private fun copyEndpoint() {
        val url = "http://${NetworkInfo.localIp(this)}:${NetworkInfo.PORT}/"
        (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("xscript", url))
        Toast.makeText(this, "已复制 $url", Toast.LENGTH_SHORT).show()
    }

    private fun showAiHelp() {
        val ip = NetworkInfo.localIp(this)
        val who = ClientTracker.active()
        MaterialAlertDialogBuilder(this)
            .setTitle("AI 编程连接")
            .setMessage(
                (if (who != null) "当前连接：$who\n\n" else "") +
                    "在 Cursor 中配置 xscript-mcp，设置：\nXSCRIPT_DEVICE=$ip:${NetworkInfo.PORT}\n\n" +
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
                Toast.makeText(this, if (ok) "已获取 Root" else "未获取 Root", Toast.LENGTH_SHORT).show()
                refresh()
            }
        }
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
        val box = LinearLayout(this).apply {
            val p = UiKit.dp(this@MainActivity, 20f)
            setPadding(p, UiKit.dp(this@MainActivity, 8f), p, 0)
            addView(input, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        MaterialAlertDialogBuilder(this)
            .setTitle("云端控制")
            .setMessage("设备主动连接控制服务器的 WebSocket，服务器即可远程调用与局域网相同的接口。" +
                if (CloudClient.lastError.isNotEmpty()) "\n\n最近错误：${CloudClient.lastError}" else "")
            .setView(box)
            .setPositiveButton("连接") { _, _ ->
                try {
                    CloudClient.connect(this, input.text.toString())
                } catch (e: Exception) {
                    Toast.makeText(this, e.message, Toast.LENGTH_LONG).show()
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
