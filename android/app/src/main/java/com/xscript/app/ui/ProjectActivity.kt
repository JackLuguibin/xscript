package com.xscript.app.ui

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
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
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

/** One project: run / stop, 开机自启 / 停止后重新运行, 定时任务, file list, delete. */
class ProjectActivity : AppCompatActivity() {
    private val ui by lazy { UiKit.palette(this) }
    private lateinit var name: String
    private lateinit var store: ProjectStore
    private lateinit var options: LinearLayout
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
        val col = UiKit.screen(this, name, store.dir(name).absolutePath)
        UiKit.barAction(col, "删除") { confirmDelete() }

        val actions = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, UiKit.dp(this@ProjectActivity, 12f), 0, 0)
        }
        runBtn = UiKit.button(this, "运行", UiKit.Tone.SUCCESS) { toggle() }
        actions.addView(runBtn, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        val logBtn = UiKit.button(this, "日志", UiKit.Tone.PRIMARY) { startActivity(Intent(this, LogActivity::class.java)) }
        actions.addView(logBtn, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
            leftMargin = UiKit.dp(this@ProjectActivity, 12f)
        })
        col.addView(actions)

        options = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        col.addView(options)
        files = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        col.addView(files)
    }

    override fun onResume() {
        super.onResume()
        renderOptions()
        renderFiles()
        handler.post(tick)
    }

    override fun onPause() {
        handler.removeCallbacks(tick)
        super.onPause()
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
            running != null -> Toast.makeText(this, "$running 正在运行，先停止它", Toast.LENGTH_SHORT).show()
            else -> {
                Settings.lastProject = name
                ScriptService.run(this, name)
                startActivity(Intent(this, LogActivity::class.java))
            }
        }
    }

    // ------------------------------------------------------------------ run options

    private fun renderOptions() {
        options.removeAllViews()
        val card = UiKit.card(options)
        val boot = Settings.bootProject == name
        UiKit.row(card, "⏻", 0xFF2F7CF6.toInt(), "开机自启", if (boot) "已开启" else "关闭", chevron = false) {
            Settings.bootProject = if (boot) "" else name
            if (!boot && Settings.bootProject == name) {
                Toast.makeText(this, "开机后等待无障碍或 Root 就绪再运行（同一时间只有一个小程序开机自启）", Toast.LENGTH_LONG).show()
            }
            renderOptions()
        }.value.setTextColor(if (boot) ui.success else ui.muted)
        val rerun = name in Settings.rerunProjects
        UiKit.row(card, "↻", 0xFF8E44AD.toInt(), "停止后重新运行", if (rerun) "已开启" else "关闭", chevron = false) {
            Settings.rerunProjects = if (rerun) Settings.rerunProjects - name else Settings.rerunProjects + name
            renderOptions()
        }.value.setTextColor(if (rerun) ui.success else ui.muted)

        val sched = UiKit.card(options)
        val list = Scheduler.store(this).list(name)
        UiKit.row(sched, "⏰", 0xFFF59E0B.toInt(), "定时任务", "${list.size} 个 · 添加") { addSchedule() }
        for (s in list) {
            val next = if (s.enabled && s.next > 0) "下次 " + LocalDateTime.ofInstant(java.time.Instant.ofEpochMilli(s.next), ZoneId.systemDefault()).format(NEXT_FORMAT) else "已停用"
            UiKit.row(sched, null, 0, s.label(), next) { editSchedule(s) }
        }
        if (list.isNotEmpty() && !Scheduler.canExact(this) && Build.VERSION.SDK_INT >= 31) {
            UiKit.row(sched, "!", ui.danger, "精确闹钟未授权", "可能延迟几分钟") {
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
                        Toast.makeText(this, "至少选一天", Toast.LENGTH_SHORT).show()
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
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val p = UiKit.dp(this@ProjectActivity, 20f)
            setPadding(p, UiKit.dp(this@ProjectActivity, 8f), p, 0)
            addView(every)
            addView(window)
        }
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
                if (error != null) Toast.makeText(this, error, Toast.LENGTH_LONG).show()
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
                        if (msg != null) Toast.makeText(ctx, msg, Toast.LENGTH_SHORT).show()
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
        val card = UiKit.card(files)
        for (i in 0 until arr.length()) {
            val f = arr.getJSONObject(i)
            val path = f.getString("path")
            val editable = path.substringAfterLast('.', "").lowercase() in EDITABLE
            val size = f.optLong("size")
            val sizeLabel = if (size > 1024) "${size / 1024} KB" else "$size B"
            UiKit.row(card, null, 0, path, sizeLabel, chevron = editable, onClick = if (editable) {
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
                UiKit.row(card, null, 0, "…还有 ${arr.length() - i} 个文件", "", chevron = false)
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
