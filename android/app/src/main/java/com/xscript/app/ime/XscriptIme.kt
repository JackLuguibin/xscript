package com.xscript.app.ime

import android.inputmethodservice.InputMethodService
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.ExtractedTextRequest

/**
 * XScript 输入法: an InputMethodService without a keyboard view. While it is the current IME, scripts type through
 * [ImeControl] (commit text, delete, enter, clear, key codes) straight into the focused field's InputConnection, which works
 * in apps where accessibility SET_TEXT is ignored (games, WebViews, custom editors).
 */
class XscriptIme : InputMethodService() {
    @Volatile var inputActive = false
        private set
    @Volatile var editor: EditorInfo? = null
        private set

    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    override fun onCreateInputView(): View? = null // no keyboard: scripts are the keyboard
    override fun onEvaluateFullscreenMode(): Boolean = false

    override fun onStartInput(attribute: EditorInfo?, restarting: Boolean) {
        super.onStartInput(attribute, restarting)
        editor = attribute
        inputActive = attribute != null && attribute.inputType != 0
    }

    override fun onFinishInput() {
        inputActive = false
        editor = null
        super.onFinishInput()
    }

    fun commit(text: String): Boolean = currentInputConnection?.commitText(text, 1) ?: false

    fun delete(before: Int, after: Int): Boolean = currentInputConnection?.deleteSurroundingText(before, after) ?: false

    fun clear(): Boolean {
        val ic = currentInputConnection ?: return false
        val all = ic.getExtractedText(ExtractedTextRequest(), 0)?.text
        if (all != null) {
            ic.beginBatchEdit()
            try {
                ic.setSelection(all.length, all.length)
                return ic.deleteSurroundingText(all.length, 0)
            } finally {
                ic.endBatchEdit()
            }
        }
        val (b, a) = ImeIds.clearCounts(ic.getTextBeforeCursor(100_000, 0), ic.getTextAfterCursor(100_000, 0))
        return ic.deleteSurroundingText(b, a)
    }

    /** Enter: the editor's action (search / send / go …) when it has one, otherwise a newline key. */
    fun enter(): Boolean {
        val ic = currentInputConnection ?: return false
        val action = (editor?.imeOptions ?: 0) and EditorInfo.IME_MASK_ACTION
        val noEnterAction = (editor?.imeOptions ?: 0) and EditorInfo.IME_FLAG_NO_ENTER_ACTION != 0
        if (!noEnterAction && action != EditorInfo.IME_ACTION_NONE && action != EditorInfo.IME_ACTION_UNSPECIFIED) {
            return ic.performEditorAction(action)
        }
        return key(KeyEvent.KEYCODE_ENTER)
    }

    fun key(code: Int): Boolean {
        val ic = currentInputConnection ?: return false
        return ic.sendKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, code)) && ic.sendKeyEvent(KeyEvent(KeyEvent.ACTION_UP, code))
    }

    /** Hand the keyboard back (API 28+ lets the current IME switch by id). */
    fun switchTo(id: String): Boolean = try {
        if (android.os.Build.VERSION.SDK_INT >= 28) { switchInputMethod(id); true } else false
    } catch (_: Exception) {
        false
    }

    companion object {
        @Volatile var instance: XscriptIme? = null
            internal set
    }
}
