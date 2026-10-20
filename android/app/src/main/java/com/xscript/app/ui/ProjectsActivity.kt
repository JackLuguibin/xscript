package com.xscript.app.ui

import com.xscript.app.R
import android.app.Activity
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import android.content.Intent
import android.os.Bundle
import android.view.ViewGroup
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.AbsoluteSizeSpan
import android.text.style.ForegroundColorSpan
import android.view.View
import android.widget.EditText
import android.widget.RadioGroup
import android.widget.ScrollView
import android.widget.TextView
import com.google.android.material.radiobutton.MaterialRadioButton
import com.xscript.app.project.ProjectTemplates
import android.widget.LinearLayout
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
        val col = UiKit.screen(this, "小程序列表")
        UiKit.barAction(col, "新建") { create() }
        UiKit.barAction(col, "导入") { chooseImport() }
        list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        col.addView(list)
        UiKit.note(col, "入口文件为 __init__.py。AScript 脚本（from ascript.android import ...）可以直接运行。")
        UiKit.note(col, "存放位置：" + store.root.absolutePath).setTextIsSelectable(true)
    }

    private fun create() {
        val templates = try { ProjectTemplates.load(this) } catch (e: Exception) { null }
        if (templates == null || templates.all.isEmpty()) {
            askName("新建小程序", "demo") { name ->
                store.create(name)
                openProject(name)
            }
            return
        }
        val input = EditText(this).apply {
            setText("demo")
            isSingleLine = true
            selectAll()
            contentDescription = "工程名称"
        }
        val group = RadioGroup(this).apply { orientation = RadioGroup.VERTICAL }
        val ids = HashMap<Int, String>()
        for (t in templates.all) {
            val label = SpannableStringBuilder(t.label)
            if (t.detail.isNotEmpty()) {
                val start = label.length
                label.append("\n").append(t.detail)
                label.setSpan(ForegroundColorSpan(ui.muted), start, label.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                label.setSpan(AbsoluteSizeSpan(UiKit.Type.CAPTION.toInt(), true), start, label.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
            val rb = MaterialRadioButton(this).apply {
                id = View.generateViewId()
                text = label
                textSize = UiKit.Type.BODY
                setTextColor(ui.text)
                minHeight = UiKit.dp(this@ProjectsActivity, UiKit.MIN_TOUCH_DP)
                val v = UiKit.dp(this@ProjectsActivity, UiKit.Space.XS)
                setPadding(paddingLeft, v, paddingRight, v)
                tag = "tpl:" + t.id
            }
            ids[rb.id] = t.id
            group.addView(rb, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            if (t.id == ProjectTemplates.DEFAULT) group.check(rb.id)
        }
        val caption = TextView(this).apply {
            text = "模板"
            textSize = UiKit.Type.LABEL
            setTextColor(ui.muted)
            setPadding(0, UiKit.dp(this@ProjectsActivity, UiKit.Space.M), 0, UiKit.dp(this@ProjectsActivity, UiKit.Space.XS))
        }
        val box = UiKit.dialogField(this, input, caption, group)
        val scroll = ScrollView(this).apply { addView(box) }
        MaterialAlertDialogBuilder(this)
            .setTitle("新建小程序")
            .setMessage("名称用作 Python 包名：字母/汉字/数字/下划线，不能以数字开头")
            .setView(scroll)
            .setPositiveButton("创建") { _, _ ->
                val name = input.text.toString().trim()
                val id = ids[group.checkedRadioButtonId] ?: ProjectTemplates.DEFAULT
                try {
                    ProjectStore.sanitize(name)
                    check(!store.exists(name)) { "工程已存在: $name" }
                    store.createFromTemplate(name, templates.render(id, name))
                    openProject(name)
                } catch (e: Exception) {
                    UiKit.toast(this, e.message, long = true)
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    override fun onResume() {
        super.onResume()
        render()
    }

    private fun render() {
        list.removeAllViews()
        val details = store.describe()
        if (details.length() == 0) {
            UiKit.empty(list, "还没有小程序", "新建一个，或导入 zip / 已安装的 AScript 脚本", "新建" to { create() }, "导入" to { chooseImport() })
            return
        }
        val card = UiKit.card(list)
        val running = RunState.current(this)
        val fmt = SimpleDateFormat("MM-dd HH:mm", Locale.getDefault())
        for (i in 0 until details.length()) {
            val d = details.getJSONObject(i)
            val name = d.getString("name")
            val flavor = d.optString("flavor")
            val icon = if (flavor == "ascript") R.drawable.ic_sym_extension else R.drawable.ic_sym_code_blocks
            val status = if (running == name) "运行中" else fmt.format(Date(d.optLong("modified")))
            val row = UiKit.row(card, icon, name, status) { openProject(name) }
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
                    UiKit.toast(this, "未找到 AScript 工程（需要 Root 或文件访问权限）", long = true)
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
        val box = UiKit.dialogField(this, input)
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
                    UiKit.toast(this, e.message, long = true)
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun work(label: String, showResult: Boolean = true, block: () -> String) {
        UiKit.toast(this, label)
        thread {
            val msg = try {
                block()
            } catch (e: Exception) {
                "失败：" + (e.message ?: e.toString())
            }
            runOnUiThread {
                if (showResult || msg.startsWith("失败")) UiKit.toast(this, msg, long = true)
                if (!isDestroyed) render()
            }
        }
    }

    companion object {
        fun start(activity: Activity) = activity.startActivity(Intent(activity, ProjectsActivity::class.java))
    }
}
