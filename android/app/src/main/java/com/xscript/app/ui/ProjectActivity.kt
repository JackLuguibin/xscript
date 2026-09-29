package com.xscript.app.ui

import android.app.AlertDialog
import android.content.Intent
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.xscript.app.project.ProjectStore
import com.xscript.app.runtime.RunState
import com.xscript.app.runtime.ScriptService
import com.xscript.app.settings.Settings

/** One project: run / stop, file list, delete. */
class ProjectActivity : AppCompatActivity() {
    private lateinit var name: String
    private lateinit var store: ProjectStore
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
        runBtn = UiKit.button(this, "运行", UiKit.GREEN) { toggle() }
        actions.addView(runBtn, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        val logBtn = UiKit.button(this, "日志", UiKit.BLUE) { startActivity(Intent(this, LogActivity::class.java)) }
        actions.addView(logBtn, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
            leftMargin = UiKit.dp(this@ProjectActivity, 12f)
        })
        col.addView(actions)

        files = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        col.addView(files)
    }

    override fun onResume() {
        super.onResume()
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
            runBtn.text = "停止"
            runBtn.background = UiKit.ripple(UiKit.RED, 22f, this)
        } else {
            runBtn.text = if (running != null) "运行中: $running" else "运行"
            runBtn.background = UiKit.ripple(if (running != null) UiKit.MUTED else UiKit.GREEN, 22f, this)
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
        AlertDialog.Builder(this)
            .setTitle("删除 $name？")
            .setMessage("会删除设备上该小程序的全部文件，无法恢复。")
            .setPositiveButton("删除") { _, _ ->
                if (RunState.current(this) == name) ScriptService.stop(this)
                store.delete(name)
                finish()
            }
            .setNegativeButton("取消", null)
            .show()
    }

    companion object {
        const val EXTRA_NAME = "name"
        val EDITABLE = setOf("py", "txt", "md", "json", "yaml", "yml", "html", "js", "css", "as", "ini", "cfg", "toml", "csv")
    }
}
