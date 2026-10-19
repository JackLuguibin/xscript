package com.xscript.app.ui

import android.app.Activity
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import android.content.Intent
import android.os.Bundle
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import com.xscript.app.project.ProjectStore
import com.xscript.app.runtime.RunState
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.concurrent.thread

/** 小程序列表: local projects, plus import from zip or from an installed AScript. */
class ProjectsActivity : AppCompatActivity() {
    private val ui by lazy { UiKit.palette(this) }
    private lateinit var store: ProjectStore
    private lateinit var list: LinearLayout

    private val pickZip = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri == null) return@registerForActivityResult
        val guess = (uri.lastPathSegment ?: "project").substringAfterLast('/').substringAfterLast(':')
            .removeSuffix(".zip").replace(Regex("""[^\p{L}\p{N}_]"""), "_").ifEmpty { "project" }
        askName("导入 zip", guess) { name ->
            work("导入中") {
                contentResolver.openInputStream(uri)!!.use { store.importZip(name, it) }
                "已导入 $name"
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = ProjectStore(this)
        val col = UiKit.screen(this, "小程序列表", store.root.absolutePath)
        UiKit.barAction(col, "新建") {
            askName("新建小程序", "demo") { name ->
                store.create(name)
                openProject(name)
            }
        }
        UiKit.barAction(col, "导入") { chooseImport() }
        list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        col.addView(list)
        UiKit.note(col, "入口文件为 __init__.py。AScript 脚本（from ascript.android import ...）可以直接运行。")
    }

    override fun onResume() {
        super.onResume()
        render()
    }

    private fun render() {
        list.removeAllViews()
        val details = store.describe()
        val card = UiKit.card(list)
        if (details.length() == 0) {
            UiKit.row(card, null, 0, "还没有小程序", "点右上角新建或导入", chevron = false)
            return
        }
        val running = RunState.current(this)
        val fmt = SimpleDateFormat("MM-dd HH:mm", Locale.getDefault())
        for (i in 0 until details.length()) {
            val d = details.getJSONObject(i)
            val name = d.getString("name")
            val flavor = d.optString("flavor")
            val glyph = if (flavor == "ascript") "A" else "X"
            val color = if (flavor == "ascript") 0xFF00B8D4.toInt() else 0xFF2F7CF6.toInt()
            val status = if (running == name) "运行中" else fmt.format(Date(d.optLong("modified")))
            val row = UiKit.row(card, glyph, color, name, status) { openProject(name) }
            if (running == name) row.value(status, ui.success)
        }
    }

    private fun openProject(name: String) {
        startActivity(Intent(this, ProjectActivity::class.java).putExtra(ProjectActivity.EXTRA_NAME, name))
    }

    private fun chooseImport() {
        MaterialAlertDialogBuilder(this)
            .setTitle("导入小程序")
            .setItems(arrayOf("从 zip 文件导入", "从 AScript 导入 (/sdcard/airscript/model)")) { _, which ->
                if (which == 0) {
                    pickZip.launch(arrayOf("application/zip", "application/x-zip-compressed", "application/octet-stream"))
                } else {
                    importFromAscript()
                }
            }
            .show()
    }

    private fun importFromAscript() {
        work("查找中", showResult = false) {
            val names = store.ascriptProjects()
            runOnUiThread {
                if (names.isEmpty()) {
                    Toast.makeText(this, "未找到 AScript 工程（需要 Root 或文件访问权限）", Toast.LENGTH_LONG).show()
                    return@runOnUiThread
                }
                MaterialAlertDialogBuilder(this)
                    .setTitle("选择 AScript 工程")
                    .setItems(names.toTypedArray()) { _, which ->
                        val n = names[which]
                        work("复制 $n") {
                            store.importAscript(n)
                            "已导入 $n"
                        }
                    }
                    .show()
            }
            ""
        }
    }

    private fun askName(title: String, initial: String, onOk: (String) -> Unit) {
        val input = EditText(this).apply {
            setText(initial)
            isSingleLine = true
            selectAll()
        }
        val box = LinearLayout(this).apply {
            val p = UiKit.dp(this@ProjectsActivity, 20f)
            setPadding(p, UiKit.dp(this@ProjectsActivity, 8f), p, 0)
            addView(input, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        MaterialAlertDialogBuilder(this)
            .setTitle(title)
            .setMessage("名称用作 Python 包名：字母/汉字/数字/下划线，不能以数字开头")
            .setView(box)
            .setPositiveButton("确定") { _, _ ->
                val name = input.text.toString().trim()
                try {
                    ProjectStore.sanitize(name)
                    onOk(name)
                } catch (e: Exception) {
                    Toast.makeText(this, e.message, Toast.LENGTH_LONG).show()
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun work(label: String, showResult: Boolean = true, block: () -> String) {
        val toast = Toast.makeText(this, label, Toast.LENGTH_SHORT)
        toast.show()
        thread {
            val msg = try {
                block()
            } catch (e: Exception) {
                "失败：" + (e.message ?: e.toString())
            }
            runOnUiThread {
                if (showResult || msg.startsWith("失败")) Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
                if (!isDestroyed) render()
            }
        }
    }

    companion object {
        fun start(activity: Activity) = activity.startActivity(Intent(activity, ProjectsActivity::class.java))
    }
}
