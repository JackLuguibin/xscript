package com.xscript.app.ui

import com.xscript.app.R
import android.Manifest
import androidx.appcompat.app.AlertDialog
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import android.content.ComponentName
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings as AndroidSettings
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import com.xscript.app.XscriptApp
import com.xscript.app.a11y.AccessibilityEngine
import com.xscript.app.a11y.XscriptAccessibilityService
import com.xscript.app.capture.CaptureEngine
import com.xscript.app.cloud.CloudClient
import com.xscript.app.http.DeviceHttpService
import com.xscript.app.license.LicenseManager
import com.xscript.app.pack.AppOps
import com.xscript.app.pack.AppOpsModel
import com.xscript.app.pack.PackInstaller
import com.xscript.app.root.RootShell
import com.xscript.app.runtime.RunState
import com.xscript.app.runtime.ScriptService
import com.xscript.app.ui.FloatControl
import kotlin.concurrent.thread

/**
 * Home screen of a packaged app (APK 打包): one project, a big run button, 卡密 activation
 * and the permissions the script needs. No developer tools.
 */
class PackActivity : AppCompatActivity() {
    private val ui by lazy { UiKit.palette(this) }
    private val handler = Handler(Looper.getMainLooper())
    private val tick = object : Runnable {
        override fun run() {
            refresh()
            handler.postDelayed(this, 1500)
        }
    }

    private lateinit var run: UiKit.RunCardViews
    private lateinit var permsHeader: UiKit.Section
    private lateinit var rowBattery: UiKit.Row
    private lateinit var rowLicense: UiKit.Row
    private lateinit var rowA11y: UiKit.Row
    private lateinit var rowOverlay: UiKit.Row
    private lateinit var rowFloat: UiKit.Row
    private lateinit var rowCapture: UiKit.Row
    private lateinit var rowRoot: UiKit.Row
    private var rowCloud: UiKit.Row? = null
    private var rowNotice: UiKit.Row? = null
    private var rowUpdate: UiKit.Row? = null
    private var updateDialog: AlertDialog? = null
    private var coldStart = true
    private var noticeDialog: AlertDialog? = null

    private val notifyPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        DeviceHttpService.start(this)
    }

    private val capturePermission = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val data = result.data
        if (result.resultCode == CaptureEngine.RESULT_OK && data != null) {
            DeviceHttpService.deliverProjection(this, result.resultCode, data)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val label = applicationInfo.loadLabel(packageManager).toString()
        val col = UiKit.screen(this, label, "v" + XscriptApp.versionName(this), back = false)
        UiKit.barAction(col, "日志") { startActivity(Intent(this, LogActivity::class.java)) }

        run = UiKit.runCard(col) { toggleRun() }

        // 授权与更新 only when the build has a license or an ops server; an empty section header would look broken.
        val ops: LinearLayout? = if (LicenseManager.required() || AppOps.enabled()) {
            UiKit.section(col, "授权与更新")
            UiKit.card(col, UiKit.Space.S)
        } else null
        rowLicense = if (LicenseManager.required() && ops != null) {
            UiKit.row(ops, R.drawable.ic_sym_key, "卡密授权") { activateDialog() }
        } else {
            UiKit.Row(LinearLayout(this), TextView(this), TextView(this), ui.muted)
        }

        if (AppOps.enabled() && ops != null) {
            rowNotice = UiKit.row(ops, R.drawable.ic_sym_campaign, "公告") { showNotices(AppOps.notices(this), all = true) }
            rowUpdate = UiKit.row(ops, R.drawable.ic_sym_system_update, "应用更新") {
                val u = AppOps.update(this)
                if (u != null && (AppOps.mustUpdate(this) || AppOps.offerUpdate(this))) showUpdateDialog(u, AppOps.mustUpdate(this))
                else AppOps.checkAsync(this, force = true) { runOnUiThread { refresh(); afterCheck() } }
            }
        }

        permsHeader = UiKit.section(col, "权限")
        val perms = UiKit.card(col, UiKit.Space.S)
        rowA11y = UiKit.row(perms, R.drawable.ic_sym_accessibility_new, "无障碍服务") {
            startActivity(Intent(AndroidSettings.ACTION_ACCESSIBILITY_SETTINGS))
        }
        rowFloat = UiKit.row(perms, R.drawable.ic_sym_picture_in_picture, "悬浮窗显示") { FloatControl.chooseMode(this) { refresh() } }
        rowOverlay = UiKit.row(perms, R.drawable.ic_sym_layers, "悬浮窗权限") {
            startActivity(FloatControl.permissionIntent(this))
        }
        rowCapture = UiKit.row(perms, R.drawable.ic_sym_screenshot_monitor, "截图权限") {
            val mgr = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            capturePermission.launch(mgr.createScreenCaptureIntent())
        }
        rowRoot = UiKit.row(perms, R.drawable.ic_sym_terminal, "Root 权限") { RootShell.probeAsync { runOnUiThread { refresh() } } }
        rowBattery = UiKit.row(perms, R.drawable.ic_sym_battery_saver, "后台运行") {
            startActivity(Intent(AndroidSettings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:$packageName")
            })
        }
        if (com.xscript.app.settings.Settings.cloudUrl.isNotEmpty()) {
            UiKit.section(col, "云控")
            val cloud = UiKit.card(col, UiKit.Space.S)
            rowCloud = UiKit.row(cloud, R.drawable.ic_sym_cloud, "云端控制", chevron = false)
        }
        UiKit.note(col, "设备 ID：" + CloudClient.deviceId(this))

        if (Build.VERSION.SDK_INT >= 33) notifyPermission.launch(Manifest.permission.POST_NOTIFICATIONS) else DeviceHttpService.start(this)
    }

    override fun onResume() {
        super.onResume()
        RootShell.probeAsync()
        handler.post(tick)
        afterCheck()
        // A cold start always asks the server (a forced update must not wait out the 1-minute throttle).
        AppOps.checkAsync(this, force = coldStart) { runOnUiThread { refresh(); afterCheck() } }
        coldStart = false
    }

    override fun onPause() {
        handler.removeCallbacks(tick)
        super.onPause()
    }

    private fun refresh() {
        val running = RunState.current(this) != null
        val gate = AppOps.gate(this) ?: LicenseManager.check(this)
        val licenseBlocked = LicenseManager.check(this) != null
        val needA11y = !AccessibilityEngine.isOn() && RootShell.known() != true
        UiKit.showRunCard(run, PackModel.runCard(running, gate, AppOps.mustUpdate(this), licenseBlocked, needA11y))

        if (AppOps.enabled()) {
            val n = AppOps.notices(this).size
            rowNotice?.value(if (n == 0) "暂无" else "$n 条", if (AppOps.unseenNotices(this).isNotEmpty()) ui.danger else ui.muted)
            rowUpdate?.value(
                when {
                    AppOps.mustUpdate(this) -> "必须更新"
                    AppOps.offerUpdate(this) -> "有新版本"
                    else -> "已是最新"
                },
                if (AppOps.mustUpdate(this)) ui.danger else if (AppOps.offerUpdate(this)) ui.success else ui.muted,
            )
        }
        if (LicenseManager.required()) {
            val st = LicenseManager.status(this)
            if (st.optBoolean("activated") && gate == null) {
                val exp = st.optLong("expires")
                val until = if (exp == 0L) "永久" else java.text.SimpleDateFormat("yyyy-MM-dd HH:mm", java.util.Locale.CHINA).format(java.util.Date(exp * 1000))
                val (text, ok) = PackModel.licenseValue(true, until, LicenseManager.usesLeft(this), gate)
                rowLicense.value(text, if (ok) ui.success else ui.danger)
            } else {
                rowLicense.value(PackModel.licenseValue(false, "", -1, gate).first, ui.danger)
            }
        }
        val a11y = AccessibilityEngine.isOn() || isAccessibilityListed()
        rowA11y.value(if (a11y) "已开启" else "未开启", if (a11y) ui.success else ui.danger)
        val overlay = FloatControl.canShow(this)
        rowOverlay.value(if (overlay) "已授权" else "未授权，点此开启", if (overlay) ui.success else ui.muted)
        rowFloat.value(FloatControl.modeSummary(this))
        rowCapture.value(CaptureEngine.sourceLabel(), if (CaptureEngine.available()) ui.success else ui.muted)
        when (RootShell.known()) {
            true -> rowRoot.value("已获取", ui.success)
            false -> rowRoot.value("未获取")
            null -> rowRoot.value("检测中")
        }
        val battery = (getSystemService(POWER_SERVICE) as PowerManager).isIgnoringBatteryOptimizations(packageName)
        rowBattery.value(if (battery) "不受限" else "受限", if (battery) ui.success else ui.muted)
        var granted = 0
        for (on in listOf(a11y, overlay, CaptureEngine.available(), RootShell.known() == true, battery)) if (on) granted++
        UiKit.setText(permsHeader.value, HomeModel.permissionSummary(granted, 5))
        rowCloud?.value(CloudClient.label(), if (CloudClient.state == CloudClient.State.CONNECTED) ui.success else ui.muted)
    }

    private fun toggleRun() {
        if (RunState.current(this) != null) {
            ScriptService.stop(this)
            return
        }
        if (AppOps.mustUpdate(this)) {
            AppOps.update(this)?.let { showUpdateDialog(it, true) }
            return
        }
        if (LicenseManager.check(this) != null) {
            activateDialog()
            return
        }
        val gate = ScriptService.run(this, PackInstaller.project)
        UiKit.toast(this, gate ?: if (LicenseManager.required()) "正在启动…" else "已启动")
    }

    /** After a check (or on resume): forced update first, then unseen 公告, then an optional update. */
    private fun afterCheck() {
        if (isFinishing || !AppOps.enabled()) return
        val u = AppOps.update(this)
        if (u != null && AppOps.mustUpdate(this)) {
            showUpdateDialog(u, true)
            return
        }
        val unseen = AppOps.unseenNotices(this)
        if (unseen.isNotEmpty()) {
            showNotices(unseen, all = false)
            return
        }
        if (u != null && AppOps.offerUpdate(this) && AppOps.dismissedCode(this) != u.latestCode) showUpdateDialog(u, false)
    }

    private fun showNotices(items: List<AppOpsModel.Notice>, all: Boolean) {
        if (noticeDialog?.isShowing == true || updateDialog?.isShowing == true) return
        if (items.isEmpty()) {
            UiKit.toast(this, "暂无公告")
            return
        }
        val text = items.joinToString("\n\n") { n ->
            val tag = when (n.level) { "urgent" -> "【紧急】"; "warning" -> "【提醒】"; else -> "" }
            tag + n.title + (if (n.body.isNotBlank()) "\n" + n.body else "")
        }
        noticeDialog = MaterialAlertDialogBuilder(this)
            .setTitle(if (all) "公告" else "新公告")
            .setMessage(text)
            .setPositiveButton("知道了") { _, _ -> AppOps.markSeen(this, items); refresh() }
            .setOnCancelListener { AppOps.markSeen(this, items); refresh() }
            .show()
    }

    private fun showUpdateDialog(u: AppOpsModel.Update, force: Boolean) {
        if (updateDialog?.isShowing == true) return
        noticeDialog?.dismiss()
        val server = AppOps.server()
        val resolved = AppOpsModel.resolveUrl(server, u.url)
        val inApp = resolved != null && AppOpsModel.inAppDownload(server, resolved)
        val msg = buildString {
            append("当前版本 v").append(XscriptApp.versionName(this@PackActivity)).append("，最新 ").append(u.latestName.ifEmpty { "#" + u.latestCode })
            if (force) append("\n\n低于最低要求（").append(u.minCode).append("），更新后才能继续使用。")
            if (u.notes.isNotBlank()) append("\n\n").append(u.notes)
        }
        val b = MaterialAlertDialogBuilder(this).setTitle(if (force) "必须更新" else "发现新版本").setMessage(msg).setCancelable(!force)
            .setPositiveButton(if (inApp) "下载并安装" else "打开下载页", null)
        if (!force) b.setNegativeButton("稍后") { _, _ -> AppOps.dismissUpdate(this, u.latestCode) }
        val d = b.create()
        d.setCanceledOnTouchOutside(!force)
        d.show()
        updateDialog = d
        d.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener { btn ->
            if (!inApp) {
                AppOps.openExternal(this, u)
                return@setOnClickListener
            }
            btn.isEnabled = false
            d.setMessage(msg + "\n\n下载中 0%")
            thread(name = "xscript-apk-download") {
                val r = AppOps.download(this, u) { pct -> runOnUiThread { d.setMessage("$msg\n\n下载中 $pct%") } }
                runOnUiThread {
                    val file = r.file
                    if (file == null) {
                        d.setMessage(msg + "\n\n" + r.error)
                        (btn as TextView).text = "重试"
                        btn.isEnabled = true
                    } else {
                        val problem = AppOps.install(this, file)
                        d.setMessage(msg + "\n\n" + (problem ?: "已下载并校验，请在系统安装界面确认。"))
                        (btn as TextView).text = "重新安装"
                        btn.isEnabled = true
                    }
                }
            }
        }
    }

    private fun activateDialog() {
        // Already licensed: this is 续期. The new card's days are added after the current expiry (server side).
        val held = LicenseManager.currentExpires(this)?.takeIf { LicenseManager.check(this) == null }
        val renew = held != null
        val input = EditText(this).apply {
            hint = if (renew) "输入新的卡密" else "输入卡密"
            isSingleLine = true
        }
        val box = UiKit.dialogField(this, input)
        MaterialAlertDialogBuilder(this)
            .setTitle(if (renew) "续期" else "卡密授权")
            .setMessage(
                (if (renew) {
                    val until = if (held == 0L) "永久" else java.text.SimpleDateFormat("yyyy-MM-dd HH:mm", java.util.Locale.CHINA).format(java.util.Date(held!! * 1000))
                    "当前有效至 $until\n输入新的卡密，时长会接在当前到期时间之后。\n"
                } else "") + "设备 ID：" + CloudClient.deviceId(this),
            )
            .setView(box)
            .setPositiveButton(if (renew) "续期" else "激活") { _, _ ->
                val code = input.text.toString()
                thread(name = "xscript-activate") {
                    val res = LicenseManager.activate(this, code)
                    runOnUiThread {
                        UiKit.toast(this, res.message, long = true)
                        refresh()
                    }
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun isAccessibilityListed(): Boolean {
        val expected = ComponentName(this, XscriptAccessibilityService::class.java).flattenToString()
        val enabled = AndroidSettings.Secure.getString(contentResolver, AndroidSettings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
        return enabled.split(':').any { it.equals(expected, ignoreCase = true) }
    }
}
