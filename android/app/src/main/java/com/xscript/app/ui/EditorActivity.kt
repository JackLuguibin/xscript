package com.xscript.app.ui

import android.graphics.Typeface
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.ViewGroup
import android.widget.EditText
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ScrollView
import androidx.activity.OnBackPressedCallback
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import androidx.appcompat.app.AppCompatActivity
import com.xscript.app.project.ProjectStore

/** Plain monospace editor for quick on-device fixes. Real editing happens in Cursor. */
class EditorActivity : AppCompatActivity() {
    private val ui by lazy { UiKit.palette(this) }
    private lateinit var editor: EditText
    private lateinit var original: String
    private lateinit var project: String
    private lateinit var path: String
    /** Too big to edit here ([EditorLimit]): a read-only preview, no 保存. */
    private var readOnly = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        project = intent.getStringExtra(EXTRA_PROJECT) ?: return finish()
        path = intent.getStringExtra(EXTRA_PATH) ?: return finish()
        val store = ProjectStore(this)
        val file = store.readFile(project, path)
        original = if (file.isFile) file.readText() else ""
        readOnly = EditorLimit.tooBig(original)

        val col = UiKit.screen(this, path, project)
        if (readOnly) {
            UiKit.note(col, "文件太大（${EditorLimit.lines(original)} 行，${original.length / 1024} KB），手机上只读显示前 ${EditorLimit.PREVIEW_LINES} 行。请在电脑上（Cursor / VS Code / PyCharm）编辑。")
        } else {
            UiKit.barAction(col, "保存") { save() }
        }
        (col.parent as ScrollView).isFillViewport = true

        editor = EditText(this).apply {
            setText(if (readOnly) EditorLimit.preview(original) else original)
            if (readOnly) {
                keyListener = null  // still selectable and copyable, never edited or saved
                setTextIsSelectable(true)
            }
            typeface = Typeface.MONOSPACE
            textSize = UiKit.Type.LABEL
            gravity = Gravity.TOP or Gravity.START
            setHorizontallyScrolling(true)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            setBackgroundColor(ui.card)
            val p = UiKit.dp(this@EditorActivity, UiKit.Space.M)
            setPadding(p, p, p, p)
            minHeight = resources.displayMetrics.heightPixels
        }
        val h = HorizontalScrollView(this).apply { isFillViewport = true }
        h.addView(editor, ViewGroup.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.MATCH_PARENT))
        col.addView(h, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            topMargin = UiKit.dp(this@EditorActivity, UiKit.Space.S)
        })

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (readOnly || editor.text.toString() == original) {
                    finish()
                    return
                }
                MaterialAlertDialogBuilder(this@EditorActivity)
                    .setTitle("保存修改？")
                    .setPositiveButton("保存") { _, _ -> save(); finish() }
                    .setNegativeButton("放弃") { _, _ -> finish() }
                    .setNeutralButton("取消", null)
                    .show()
            }
        })
    }

    private fun save() {
        if (readOnly) return
        val text = editor.text.toString()
        ProjectStore(this).writeFile(project, path, text, "utf-8")
        original = text
        UiKit.toast(this, "已保存")
    }

    companion object {
        const val EXTRA_PROJECT = "project"
        const val EXTRA_PATH = "path"
    }
}
