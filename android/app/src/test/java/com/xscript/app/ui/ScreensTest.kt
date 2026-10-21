package com.xscript.app.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Structure of the secondary screens. The views are built in code and the unit tests run without Android, so these
 * check the sources; the emulator walk-through checks the rendered screens.
 */
class ScreensTest {
    private val src = File(
        generateSequence(File("").absoluteFile) { it.parentFile }
            .first { File(it, "build.gradle.kts").isFile && File(it, "src/main/res").isDirectory },
        "src/main/java/com/xscript/app/ui",
    )

    private fun read(name: String) = File(src, name).readText()

    @Test
    fun backArrowGoesThroughTheBackDispatcher() {
        // EditorActivity asks to save unsaved changes in an OnBackPressedCallback; finish() on the arrow skipped it.
        val kit = read("UiKit.kt")
        assertTrue(kit.contains("setOnClickListener { navigateBack(activity) }"))
        assertTrue(kit.contains("onBackPressedDispatcher"))
        assertTrue(read("EditorActivity.kt").contains("onBackPressedDispatcher.addCallback"))
    }

    @Test
    fun headersDoNotShowStoragePaths() {
        assertFalse(read("ProjectsActivity.kt").contains("UiKit.screen(this, \"小程序列表\", store.root"))
        assertFalse(read("ProjectActivity.kt").contains("UiKit.screen(this, name, store.dir"))
    }

    @Test
    fun newProjectDialogKeepsItsButtonsOnScreen() {
        // #216: a message plus a view makes AlertDialogLayout measure as a plain LinearLayout, so the template list
        // pushed 创建 below the screen. The rule goes inside the scrolling view and the dialog has no message.
        val projects = read("ProjectsActivity.kt")
        val create = projects.substringAfter("private fun create()").substringBefore("override fun onResume()")
        assertTrue(create.contains(".setView(scroll)"))
        assertFalse(create.contains(".setMessage("))
        assertTrue(create.contains("UiKit.dialogField(this, rule, input, caption, group)"))
        assertTrue(create.contains(".setPositiveButton(\"创建\")"))
        assertTrue(create.contains(".setNegativeButton(\"取消\", null)"))
    }

    @Test
    fun emptyStatesOfferActions() {
        assertTrue(read("ProjectsActivity.kt").contains("UiKit.empty(list, \"还没有小程序\""))
        assertTrue(read("LogActivity.kt").contains("UiKit.empty(col, \"还没有日志\""))
    }

    @Test
    fun projectOptionsAreSwitches() {
        val project = read("ProjectActivity.kt")
        assertTrue(project.contains("UiKit.switchRow(card, R.drawable.ic_sym_power_settings_new"))
        assertTrue(project.contains("UiKit.switchRow(card, R.drawable.ic_sym_restart_alt"))
    }

    @Test
    fun idleStopActionIsDisabledNotJustDimmed() {
        val log = read("LogActivity.kt")
        assertTrue(log.contains("stopAction.isEnabled = running"))
        assertTrue("set only on a change, the log polls every 700 ms", log.contains("if (stopAction.isEnabled != running)"))
    }
}
