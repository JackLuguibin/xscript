package com.xscript.app.ui

import android.Manifest
import android.app.AlertDialog
import android.content.ComponentName
import android.content.Intent
import android.graphics.Typeface
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings as AndroidSettings
import android.view.Gravity
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
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
    private val handler = Handler(Looper.getMainLooper())
    private val tick = object : Runnable {
        override fun run() {
            refresh()
            handler.postDelayed(this, 1500)
        }
    }

    private lateinit var status: TextView
    private lateinit var runButton: TextView
    private lateinit var rowLicense: UiKit.Row
    private lateinit var rowA11y: UiKit.Row
    private lateinit var rowOverlay: UiKit.Row
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

        val card = UiKit.card(col)
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            val p = UiKit.dp(this@PackActivity, 20f)
            setPadding(p, p, p, p)
        }
        status = TextView(this).apply {
            textSize = 15f
            setTextColor(UiKit.MUTED)
            gravity = Gravity.CENTER
        }
        box.addView(status)
        runButton = UiKit.button(this, "启动", UiKit.GREEN) { toggleRun() }
        box.addView(runButton, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            topMargin = UiKit.dp(this@PackActivity, 14f)
        })
        card.addView(box)

        if (LicenseManager.required()) {
            val lic = UiKit.card(col)
            rowLicense = UiKit.row(lic, "✓", 0xFF8E44AD.toInt(), "卡密授权") { activateDialog() }
        } else {
            rowLicense = UiKit.Row(LinearLayout(this), TextView(this), TextView(this))
        }

        if (AppOps.enabled()) {
            val ops = UiKit.card(col)
            rowNotice = UiKit.row(ops, "!", 0xFFF59E0B.toInt(), "公告") { showNotices(AppOps.notices(this), all = true) }
            rowUpdate = UiKit.row(ops, "↑", 0xFF2F7CF6.toInt(), "应用更新") {
                val u = AppOps.update(this)
                if (u != null && (AppOps.mustUpdate(this) || AppOps.offerUpdate(this))) showUpdateDialog(u, AppOps.mustUpdate(this))
                else AppOps.checkAsync(this, force = true) { runOnUiThread { refresh(); afterCheck() } }
            }
        }

        val perms = UiKit.card(col)
        rowA11y = UiKit.row(perms, "◉", 0xFFF59E0B.toInt(), "无障碍服务") {
            startActivity(Intent(AndroidSettings.ACTION_ACCESSIBILITY_SETTINGS))
        }
        rowOverlay = UiKit.row(perms, "▣", 0xFF34A853.toInt(), "悬浮窗权限") {
            startActivity(Intent(AndroidSettings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
        }
        rowCapture = UiKit.row(perms, "◎", 0xFFE5484D.toInt(), "截图权限") {
            val mgr = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            capturePermission.launch(mgr.createScreenCaptureIntent())
        }
        rowRoot = UiKit.row(perms, ">_", 0xFF2F7CF6.toInt(), "Root 权限") { RootShell.probeAsync { runOnUiThread { refresh() } } }
        UiKit.row(perms, "⚡", 0xFF6B7785.toInt(), "后台运行") {
            startActivity(Intent(AndroidSettings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:$packageName")
            })
        }
        if (com.xscript.app.settings.Settings.cloudUrl.isNotEmpty()) {
            val cloud = UiKit.card(col)
            rowCloud = UiKit.row(cloud, "☁", 0xFF2F9BF6.toInt(), "云控", chevron = false)
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
        status.text = when {
            running -> "运行中"
            gate != null -> gate
            !AccessibilityEngine.isOn() && RootShell.known() != true -> "请先开启无障碍服务"
            else -> "就绪"
        }
        status.setTypeface(null, if (running) Typeface.BOLD else Typeface.NORMAL)
        runButton.text = if (running) "停止" else "启动"
        runButton.background = UiKit.ripple(if (running) UiKit.RED else UiKit.GREEN, 22f, this)

        if (AppOps.enabled()) {
            val n = AppOps.notices(this).size
            rowNotice?.value(if (n == 0) "暂无" else "$n 条", if (AppOps.unseenNotices(this).isNotEmpty()) UiKit.RED else UiKit.MUTED)
            rowUpdate?.value(
                when {
                    AppOps.mustUpdate(this) -> "必须更新"
                    AppOps.offerUpdate(this) -> "有新版本"
                    else -> "已是最新"
                },
                if (AppOps.mustUpdate(this)) UiKit.RED else if (AppOps.offerUpdate(this)) UiKit.GREEN else UiKit.MUTED,
            )
        }
        if (LicenseManager.required()) {
            val st = LicenseManager.status(this)
            if (st.optBoolean("activated") && gate == null) {
                val exp = st.optLong("expires")
                val until = if (exp == 0L) "永久" else java.text.SimpleDateFormat("yyyy-MM-dd HH:mm", java.util.Locale.CHINA).format(java.util.Date(exp * 1000))
                rowLicense.value("有效至 $until", UiKit.GREEN)
            } else {
                rowLicense.value(gate ?: "未激活", UiKit.RED)
            }
        }
        val a11y = AccessibilityEngine.isOn() || isAccessibilityListed()
        rowA11y.value(if (a11y) "已开启" else "未开启", if (a11y) UiKit.GREEN else UiKit.RED)
        val overlay = FloatControl.canShow(this)
        rowOverlay.value(if (overlay) "已授权" else "未授权", if (overlay) UiKit.GREEN else UiKit.MUTED)
        rowCapture.value(CaptureEngine.sourceLabel(), if (CaptureEngine.available()) UiKit.GREEN else UiKit.MUTED)
        when (RootShell.known()) {
            true -> rowRoot.value("已获取", UiKit.GREEN)
            false -> rowRoot.value("未获取")
            null -> rowRoot.value("检测中")
        }
        rowCloud?.value(CloudClient.label(), if (CloudClient.state == CloudClient.State.CONNECTED) UiKit.GREEN else UiKit.MUTED)
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
        Toast.makeText(this, gate ?: "已启动", Toast.LENGTH_SHORT).show()
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
            Toast.makeText(this, "暂无公告", Toast.LENGTH_SHORT).show()
            return
        }
        val text = items.joinToString("\n\n") { n ->
            val tag = when (n.level) { "urgent" -> "【紧急】"; "warning" -> "【提醒】"; else -> "" }
            tag + n.title + (if (n.body.isNotBlank()) "\n" + n.body else "")
        }
        noticeDialog = AlertDialog.Builder(this)
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
        val b = AlertDialog.Builder(this).setTitle(if (force) "必须更新" else "发现新版本").setMessage(msg).setCancelable(!force)
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
        val input = EditText(this).apply {
            hint = "输入卡密"
            isSingleLine = true
        }
        val box = LinearLayout(this).apply {
            val p = UiKit.dp(this@PackActivity, 20f)
            setPadding(p, UiKit.dp(this@PackActivity, 8f), p, 0)
            addView(input, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        AlertDialog.Builder(this)
            .setTitle("卡密授权")
            .setMessage("设备 ID：" + CloudClient.deviceId(this))
            .setView(box)
            .setPositiveButton("激活") { _, _ ->
                val code = input.text.toString()
                thread(name = "xscript-activate") {
                    val res = LicenseManager.activate(this, code)
                    runOnUiThread {
                        Toast.makeText(this, res.message, Toast.LENGTH_LONG).show()
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
