package com.xscript.pycharm

import com.intellij.codeInsight.intention.IntentionAction
import com.intellij.codeInsight.intention.PriorityAction
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.ScrollType
import com.intellij.openapi.project.Project
import com.intellij.psi.PsiDocumentManager
import com.intellij.psi.PsiFile

/**
 * Alt+Enter on an XScript warning: the Web IDE's Ctrl+. action ("是不是 …" rename, `from m import name`, fill in missing
 * arguments, jump to the earlier duplicate definition). Edits are offsets into the text the check saw, so the fix is only
 * offered while the document is unchanged ([stamp]); it goes through PyCharm's undo.
 */
class LintQuickFix(private val fix: LintFix, private val stamp: Long) : IntentionAction, PriorityAction {
    override fun getText(): String = fix.title

    override fun getFamilyName(): String = "XScript"

    override fun getPriority(): PriorityAction.Priority = if (fix.preferred) PriorityAction.Priority.TOP else PriorityAction.Priority.NORMAL

    override fun isAvailable(project: Project, editor: Editor?, file: PsiFile?): Boolean =
        editor != null && (fix.edits.isEmpty() || editor.document.modificationStamp == stamp)

    override fun startInWriteAction(): Boolean = fix.edits.isNotEmpty()

    override fun invoke(project: Project, editor: Editor?, file: PsiFile?) {
        editor ?: return
        val doc = editor.document
        if (fix.edits.isEmpty()) {
            if (fix.jumpLine < 1 || fix.jumpLine > doc.lineCount) return
            val start = doc.getLineStartOffset(fix.jumpLine - 1)
            editor.caretModel.moveToOffset(minOf(start + fix.jumpCol, doc.getLineEndOffset(fix.jumpLine - 1)))
            editor.scrollingModel.scrollToCaret(ScrollType.CENTER)
            return
        }
        if (doc.modificationStamp != stamp) return
        for (e in fix.edits.sortedByDescending { it.from }) {
            if (e.from < 0 || e.to > doc.textLength || e.from > e.to) return
            doc.replaceString(e.from, e.to, e.text)
        }
        PsiDocumentManager.getInstance(project).commitDocument(doc)
    }
}
