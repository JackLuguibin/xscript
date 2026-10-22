package com.xscript.pycharm

import com.intellij.codeInspection.ProblemHighlightType
import com.intellij.lang.annotation.AnnotationHolder
import com.intellij.lang.annotation.ExternalAnnotator
import com.intellij.lang.annotation.HighlightSeverity
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.util.TextRange
import com.intellij.psi.PsiDocumentManager
import com.intellij.psi.PsiFile
import java.nio.file.Path

/**
 * The Web IDE's basic checks (undefined names with "did you mean", unknown attributes, wrong call arguments, import typos,
 * async / await misuse, duplicate definitions, ...) as warnings in .py files of an XScript project. Off with
 * Settings | Tools | XScript | Basic checks.
 */
class XScriptLintAnnotator : ExternalAnnotator<XScriptLintAnnotator.Input, List<LintProblem>>() {
    class Input(val root: Path, val file: String, val open: Map<Path, String>)

    override fun collectInformation(file: PsiFile, editor: Editor, hasErrors: Boolean): Input? = collect(file)

    override fun collectInformation(file: PsiFile): Input? = collect(file)

    private fun collect(file: PsiFile): Input? {
        if (!XScriptSettings.get().lint) return null
        val vf = file.virtualFile ?: return null
        if (vf.extension != "py" || !vf.isInLocalFileSystem) return null
        val path = runCatching { vf.toNioPath() }.getOrNull() ?: return null
        val root = LocalProject.findRoot(path, file.project.basePath?.let { Path.of(it) }) ?: return null
        val fdm = FileDocumentManager.getInstance()
        val open = HashMap<Path, String>()
        for (doc in fdm.unsavedDocuments) {
            val f = fdm.getFile(doc) ?: continue
            if (f.extension == "py" && f.isInLocalFileSystem) runCatching { open[f.toNioPath().toAbsolutePath().normalize()] = doc.text }
        }
        PsiDocumentManager.getInstance(file.project).getDocument(file)?.let { open[path.toAbsolutePath().normalize()] = it.text }
        return Input(root, root.relativize(path).joinToString("/"), open)
    }

    override fun doAnnotate(input: Input): List<LintProblem>? =
        LintEngine.get().lint(LintRules.sources(input.root, input.open), input.file)

    override fun apply(file: PsiFile, problems: List<LintProblem>?, holder: AnnotationHolder) {
        val doc = PsiDocumentManager.getInstance(file.project).getDocument(file) ?: return
        for (p in problems ?: return) {
            val line = p.line - 1
            if (line < 0 || line >= doc.lineCount) continue
            val start = doc.getLineStartOffset(line) + p.col
            val end = minOf(start + p.length, doc.getLineEndOffset(line))
            if (start >= end) continue
            holder.newAnnotation(HighlightSeverity.WARNING, "XScript: " + p.message)
                .range(TextRange(start, end))
                .highlightType(ProblemHighlightType.WARNING)
                .create()
        }
    }
}
