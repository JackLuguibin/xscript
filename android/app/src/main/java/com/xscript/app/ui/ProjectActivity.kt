package com.xscript.app.ui

import com.xscript.app.R
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import android.app.DatePickerDialog
import android.app.TimePickerDialog
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings as AndroidSettings
import android.view.Gravity
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import androidx.appcompat.app.AppCompatActivity
import androidx.activity.result.contract.ActivityResultContracts
import com.xscript.app.capture.CaptureEngine
import com.xscript.app.http.DeviceHttpService
import com.xscript.app.permission.PermissionStatus
import com.xscript.app.project.PermissionGuide
import com.xscript.app.project.PermissionNeeds
import com.xscript.app.project.ProjectStore
import com.xscript.app.runtime.RunState
import com.xscript.app.runtime.ScriptService
import com.xscript.app.schedule.Schedule
import com.xscript.app.schedule.Scheduler
import com.xscript.app.settings.Settings
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Calendar
import kotlin.concurrent.thread

/** One project: run / stop, 权限检查, 开机自启 / 停止后重新运行, 定时任务, file list, delete. */
class ProjectActivity : AppCompatActivity() {
    private val ui by lazy { UiKit.palette(this) }
    private lateinit var name: String
    private lateinit var store: ProjectStore
    private lateinit var perms: LinearLayout
    private lateinit var options: LinearLayout

    /** What this project's code uses (scanned on resume); null until the first scan finished. */
    @Volatile
    private var needs: List<PermissionNeeds.Need>? = null

    /** 「一键开启全部」 in progress: the next step is offered when the user comes back from system settings. */
    private var guide: PermissionGuide? = null
    private var guideDialog: androidx.appcompat.app.AlertDialog? = null
    private val isOk = { k: PermissionNeeds.Kind -> PermissionStatus.ok(this, k) }

    private val capturePermission = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val data = result.data
        if (result.resultCode == CaptureEngine.RESULT_OK && data != null) {
            DeviceHttpService.deliverProjection(this, result.resultCode, data)
            handler.postDelayed({ renderPermissions() }, 500)
        }
    }
    private lateinit var files: LinearLayout
    private lateinit var runBtn: android.widget.TextView
    private val handler = android.os.Handler(android.os.Looper.getMainLooper())
    private val tick = object : Runnable {
        override fun run() {
            updateRun()
            handler.postDelayed(this, 1000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        name = intent.getStringExtra(EXTRA_NAME) ?: return finish()
        store = ProjectStore(this)
        val col = UiKit.screen(this, name, "小程序")
        UiKit.barAction(col, "删除") { confirmDelete() }

        val actions = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, UiKit.dp(this@ProjectActivity, UiKit.Space.M), 0, 0)
        }
        runBtn = UiKit.button(this, "运行", UiKit.Tone.SUCCESS) { toggle() }
        actions.addView(runBtn, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        val logBtn = UiKit.button(this, "日志", UiKit.Tone.NEUTRAL) { startActivity(Intent(this, LogActivity::class.java)) }
        actions.addView(logBtn, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
            leftMargin = UiKit.dp(this@ProjectActivity, UiKit.Space.M)
        })
        col.addView(actions)

        perms = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        col.addView(perms)
        options = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        col.addView(options)
        files = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        col.addView(files)
        UiKit.note(col, "位置：" + store.dir(name).absolutePath).setTextIsSelectable(true)
    }

    override fun onResume() {
        super.onResume()
        // back from a settings screen during the guide: give the service a moment to bind, then offer the next step
        if (guide != null && guideDialog?.isShowing != true) handler.postDelayed({ continueGuide() }, 600)
        scanNeeds()
        renderOptions()
        renderFiles()
        handler.post(tick)
    }

    override fun onPause() {
        handler.removeCallbacks(tick)
        super.onPause()
    }

    override fun onDestroy() {
        guideDialog?.dismiss()
        super.onDestroy()
    }

    private fun updateRun() {
        val running = RunState.current(this)
        if (running == name) {
            UiKit.setText(runBtn, "停止")
            UiKit.paint(runBtn, UiKit.Tone.DANGER)
        } else {
            UiKit.setText(runBtn, if (running != null) "运行中: $running" else "运行")
            UiKit.paint(runBtn, if (running != null) UiKit.Tone.NEUTRAL else UiKit.Tone.SUCCESS)
        }
    }

    private fun toggle() {
        val running = RunState.current(this)
        when {
            running == name -> ScriptService.stop(this)
            running != null -> UiKit.toast(this, "$running 正在运行，先停止它")
            else -> {
                val missing = missingNeeds()
                if (missing.isEmpty()) start() else confirmRunWithout(missing)
            }
        }
    }

    private fun start() {
        Settings.lastProject = name
        ScriptService.run(this, name)
        startActivity(Intent(this, LogActivity::class.java))
    }

    // ------------------------------------------------------------------ 权限检查

    private fun missingNeeds(): List<PermissionNeeds.Need> = needs.orEmpty().filter { !PermissionStatus.ok(this, it.kind) }

    private fun confirmRunWithout(missing: List<PermissionNeeds.Need>) {
        val lines = missing.joinToString("\n") { "· ${it.kind.label}：${it.kind.why}（${it.where}）" }
        MaterialAlertDialogBuilder(this)
            .setTitle("还缺 ${missing.size} 项权限")
            .setMessage("这个小程序用到了：\n$lines\n\n没有这些权限，相关操作会失败。")
            .setPositiveButton("去开启") { _, _ -> startGuide() }
            .setNeutralButton("仍然运行") { _, _ -> start() }
            .setNegativeButton("取消", null)
            .show()
    }

    /** Read the project's .py files off the main thread and list what they need. */
    private fun scanNeeds() {
        val dir = store.dir(name)
        thread(name = "xscript-perm-scan") {
            val sources = LinkedHashMap<String, String>()
            dir.walkTopDown()
                .onEnter { it.name != "__pycache__" && !it.name.startsWith(".") }
                .filter { it.isFile && it.name.endsWith(".py") && it.length() <= 512 * 1024 }
                .take(300)
                .forEach { f -> sources[f.relativeTo(dir).path] = runCatching { f.readText() }.getOrDefault("") }
            needs = PermissionNeeds.scan(sources)
            runOnUiThread { if (!isFinishing) renderPermissions() }
        }
    }

    private fun renderPermissions() {
        val list = needs ?: return
        perms.removeAllViews()
        UiKit.section(perms, "权限检查")
        val card = UiKit.card(perms, UiKit.Space.S)
        if (list.isEmpty()) {
            UiKit.row(card, 0, "不需要额外权限", "", chevron = false)
            return
        }
        for (n in list) {
            val ok = PermissionStatus.ok(this, n.kind)
            val row = UiKit.row(card, PermissionStatus.icon(n.kind), n.kind.label, chevron = !ok, onClick = if (ok) null else ({ fix(n.kind) }))
            row.value(PermissionStatus.label(this, n.kind), if (ok) ui.success else ui.danger)
        }
        val missing = list.count { !PermissionStatus.ok(this, it.kind) }
        if (missing > 0) {
            val all = UiKit.button(this, if (missing == 1) "去开启" else "一键开启全部（$missing 项）", UiKit.Tone.PRIMARY) { startGuide() }
            perms.addView(all, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = UiKit.dp(this@ProjectActivity, UiKit.Space.S)
            })
        }
        UiKit.note(perms, if (missing == 0) "按代码里用到的接口检查（${list.joinToString("、") { it.kind.why }}）。" else "还缺 $missing 项：点「一键开启全部」逐项去开启，开好一项返回这里就会接着下一项；也可以点红字一行单独开启。按代码里用到的接口检查，可能不完全准确。")
    }

    // ------------------------------------------------------------------ 一键开启全部

    private fun startGuide() {
        val list = needs ?: return
        guide = PermissionGuide(list.map { it.kind }, isOk)
        continueGuide()
    }

    /** Offers the next missing permission, or says how it went. */
    private fun continueGuide() {
        val g = guide ?: return
        if (isFinishing || guideDialog?.isShowing == true) return
        renderPermissions()
        val kind = g.next(isOk)
        if (kind == null) {
            finishGuide(g)
            return
        }
        val where = needs.orEmpty().firstOrNull { it.kind == kind }?.where.orEmpty()
        val how = when (kind) {
            PermissionNeeds.Kind.ACCESSIBILITY -> "在系统的无障碍设置里找到 XScript 并打开，然后按返回键回到这里。"
            PermissionNeeds.Kind.CAPTURE -> "系统会弹出录屏确认，选「立即开始」（Android 14 起选「整个屏幕」）。"
            PermissionNeeds.Kind.OVERLAY -> "在列表里找到 XScript，打开「允许显示在其他应用的上层」，然后返回。"
            PermissionNeeds.Kind.NOTIFICATIONS -> "在通知使用权里打开 XScript，然后返回。"
            PermissionNeeds.Kind.STORAGE -> "打开「允许访问所有文件」，然后返回。"
        }
        guideDialog = MaterialAlertDialogBuilder(this)
            .setTitle("第 ${g.stepNumber()}/${g.total} 步：${kind.label}")
            .setMessage("用来${kind.why}" + (if (where.isNotEmpty()) "（$where）" else "") + "。\n\n$how")
            .setPositiveButton("去开启") { _, _ ->
                g.opened(kind)
                fix(kind)
            }
            .setNeutralButton("跳过") { _, _ ->
                g.skip(kind)
                handler.post { continueGuide() }
            }
            .setNegativeButton("结束") { _, _ -> guide = null }
            .setOnCancelListener { guide = null }
            .show()
    }

    private fun finishGuide(g: PermissionGuide) {
        guide = null
        renderPermissions()
        val left = g.remaining(isOk)
        if (left.isEmpty()) {
            UiKit.toast(this, "权限都开好了")
            return
        }
        MaterialAlertDialogBuilder(this)
            .setTitle("还缺 ${left.size} 项权限")
            .setMessage(left.joinToString("\n") { "· ${it.label}" + (if (it in g.skipped()) "（已跳过）" else "（没有开启）") } +
                "\n\n可以稍后点「权限检查」里的红字一行单独开启。")
            .setPositiveButton("知道了", null)
            .show()
    }

    private fun fix(kind: PermissionNeeds.Kind) {
        if (kind == PermissionNeeds.Kind.CAPTURE) {
            val mgr = getSystemService(MEDIA_PROJECTION_SERVICE) as android.media.projection.MediaProjectionManager
            capturePermission.launch(mgr.createScreenCaptureIntent())
            return
        }
        val intent = PermissionStatus.settingsIntent(this, kind) ?: return
        try {
            startActivity(intent)
        } catch (_: Exception) {
            UiKit.toast(this, "打不开系统设置，请手动开启「${kind.label}」")
        }
    }

    // ------------------------------------------------------------------ run options

    private fun renderOptions() {
        options.removeAllViews()
        UiKit.section(options, "运行选项")
        val card = UiKit.card(options, UiKit.Space.S)
        val boot = Settings.bootProject == name
        UiKit.switchRow(card, R.drawable.ic_sym_power_settings_new, "开机自启", boot) { on ->
            Settings.bootProject = if (on) name else if (Settings.bootProject == name) "" else Settings.bootProject
            if (on && Settings.bootProject == name) {
                UiKit.toast(this, "开机后等待无障碍或 Root 就绪再运行（同一时间只有一个小程序开机自启）", long = true)
            }
        }
        UiKit.switchRow(card, R.drawable.ic_sym_restart_alt, "停止后重新运行", name in Settings.rerunProjects) { on ->
            Settings.rerunProjects = if (on) Settings.rerunProjects + name else Settings.rerunProjects - name
        }
        UiKit.switchRow(card, R.drawable.ic_sym_screenshot_monitor, "截图失败时停止脚本", name in Settings.strictCaptureProjects) { on ->
            Settings.strictCaptureProjects = if (on) Settings.strictCaptureProjects + name else Settings.strictCaptureProjects - name
        }
        UiKit.note(
            options,
            "截图失败时停止脚本：截不到图（图色权限失效等）时找图、找色、OCR 直接报错停止，而不是返回空结果继续跑，相当于在代码开头写 screen.strict_capture()。下次运行生效。",
        )

        UiKit.section(options, "定时任务")
        val sched = UiKit.card(options, UiKit.Space.S)
        val list = Scheduler.store(this).list(name)
        UiKit.row(sched, R.drawable.ic_sym_schedule, "定时任务", "${list.size} 个 · 添加") { addSchedule() }
        for (s in list) {
            val next = if (s.enabled && s.next > 0) "下次 " + LocalDateTime.ofInstant(java.time.Instant.ofEpochMilli(s.next), ZoneId.systemDefault()).format(NEXT_FORMAT) else "已停用"
            UiKit.row(sched, 0, s.label(), next) { editSchedule(s) }
        }
        if (list.isNotEmpty() && !Scheduler.canExact(this) && Build.VERSION.SDK_INT >= 31) {
            UiKit.row(sched, R.drawable.ic_sym_alarm, "精确闹钟未授权", "可能延迟几分钟") {
                try {
                    startActivity(Intent(AndroidSettings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:$packageName")))
                } catch (_: Exception) {
                }
            }
        }
    }

    private fun addSchedule() {
        val kinds = arrayOf("每天定时", "每隔 N 分钟", "只运行一次")
        MaterialAlertDialogBuilder(this)
            .setTitle("添加定时任务")
            .setItems(kinds) { _, which ->
                when (which) {
                    0 -> pickDaily()
                    1 -> pickInterval()
                    else -> pickOnce()
                }
            }
            .show()
    }

    private fun pickDaily() {
        TimePickerDialog(this, { _, h, m ->
            val labels = arrayOf("一", "二", "三", "四", "五", "六", "日").map { "周$it" }.toTypedArray()
            val checked = BooleanArray(7) { true }
            MaterialAlertDialogBuilder(this)
                .setTitle("重复（全选 = 每天）")
                .setMultiChoiceItems(labels, checked) { _, i, on -> checked[i] = on }
                .setPositiveButton("保存") { _, _ ->
                    val days = (1..7).filter { checked[it - 1] }
                    if (days.isEmpty()) {
                        UiKit.toast(this, "至少选一天")
                        return@setPositiveButton
                    }
                    save(JSONObject().put("kind", "daily").put("time", "%02d:%02d".format(h, m)).put("weekdays", JSONArray(if (days.size == 7) emptyList() else days)))
                }
                .setNegativeButton("取消", null)
                .show()
        }, 8, 0, true).show()
    }

    private fun pickInterval() {
        val every = EditText(this).apply {
            hint = "间隔分钟，例如 30"
            inputType = android.text.InputType.TYPE_CLASS_NUMBER
        }
        val window = EditText(this).apply { hint = "时间段（可选），例如 08:00-23:00" }
        val box = UiKit.dialogField(this, every, window)
        MaterialAlertDialogBuilder(this)
            .setTitle("每隔 N 分钟")
            .setView(box)
            .setPositiveButton("保存") { _, _ ->
                save(JSONObject().put("kind", "interval").put("every", every.text.toString().toIntOrNull() ?: 0).put("window", window.text.toString().trim()))
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun pickOnce() {
        val now = Calendar.getInstance()
        DatePickerDialog(this, { _, y, mo, d ->
            TimePickerDialog(this, { _, h, mi ->
                save(JSONObject().put("kind", "once").put("at", "%04d-%02d-%02d %02d:%02d".format(y, mo + 1, d, h, mi)))
            }, now.get(Calendar.HOUR_OF_DAY), (now.get(Calendar.MINUTE) + 5) % 60, true).show()
        }, now.get(Calendar.YEAR), now.get(Calendar.MONTH), now.get(Calendar.DAY_OF_MONTH)).show()
    }

    private fun save(req: JSONObject) {
        req.put("project", name)
        thread {
            val error = try {
                Scheduler.store(this).add(req, System.currentTimeMillis())
                Scheduler.rearm(this)
                null
            } catch (e: IllegalArgumentException) {
                e.message
            }
            runOnUiThread {
                if (error != null) UiKit.toast(this, error, long = true)
                renderOptions()
            }
        }
    }

    private fun editSchedule(s: Schedule) {
        val items = arrayOf(
            if (s.enabled) "停用" else "启用",
            "立即运行",
            if (s.ifRunning == Schedule.IF_RUNNING_RESTART) "有脚本在运行时：跳过" else "有脚本在运行时：停止它再运行",
            "删除",
        )
        MaterialAlertDialogBuilder(this)
            .setTitle(s.label())
            .setItems(items) { _, which ->
                thread {
                    val ctx = this
                    val now = System.currentTimeMillis()
                    val msg = try {
                        when (which) {
                            0 -> {
                                Scheduler.store(ctx).update(s.id, JSONObject().put("enabled", !s.enabled), now)
                                Scheduler.rearm(ctx)
                                null
                            }
                            1 -> "运行: " + Scheduler.runNow(ctx, s.id)
                            2 -> {
                                val next = if (s.ifRunning == Schedule.IF_RUNNING_RESTART) Schedule.IF_RUNNING_SKIP else Schedule.IF_RUNNING_RESTART
                                Scheduler.store(ctx).update(s.id, JSONObject().put("if_running", next), now)
                                null
                            }
                            else -> {
                                Scheduler.store(ctx).remove(s.id)
                                Scheduler.rearm(ctx)
                                null
                            }
                        }
                    } catch (e: IllegalArgumentException) {
                        e.message
                    }
                    runOnUiThread {
                        if (msg != null) UiKit.toast(ctx, msg)
                        renderOptions()
                    }
                }
            }
            .show()
    }

    // ------------------------------------------------------------------ files

    private fun renderFiles() {
        files.removeAllViews()
        val arr = store.files(name)
        UiKit.section(files, "文件")
        val card = UiKit.card(files, UiKit.Space.S)
        for (i in 0 until arr.length()) {
            val f = arr.getJSONObject(i)
            val path = f.getString("path")
            val editable = path.substringAfterLast('.', "").lowercase() in EDITABLE
            val size = f.optLong("size")
            val sizeLabel = if (size > 1024) "${size / 1024} KB" else "$size B"
            UiKit.row(card, 0, path, sizeLabel, chevron = editable, onClick = if (editable) {
                {
                    startActivity(
                        Intent(this, EditorActivity::class.java)
                            .putExtra(EditorActivity.EXTRA_PROJECT, name)
                            .putExtra(EditorActivity.EXTRA_PATH, path),
                    )
                }
            } else {
                null
            })
            if (i > 300) {
                UiKit.row(card, 0, "…还有 ${arr.length() - i} 个文件", "", chevron = false)
                break
            }
        }
    }

    private fun confirmDelete() {
        MaterialAlertDialogBuilder(this)
            .setTitle("删除 $name？")
            .setMessage("会删除设备上该小程序的全部文件和定时任务，无法恢复。")
            .setPositiveButton("删除") { _, _ ->
                if (RunState.current(this) == name) ScriptService.stop(this)
                Scheduler.forgetProject(this, name)
                store.delete(name)
                finish()
            }
            .setNegativeButton("取消", null)
            .show()
    }

    companion object {
        const val EXTRA_NAME = "name"
        val EDITABLE = setOf("py", "txt", "md", "json", "yaml", "yml", "html", "js", "css", "as", "ini", "cfg", "toml", "csv")
        private val NEXT_FORMAT = DateTimeFormatter.ofPattern("MM-dd HH:mm")
    }
}
