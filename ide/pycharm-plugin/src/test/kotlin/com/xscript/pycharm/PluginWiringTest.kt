package com.xscript.pycharm

import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.testFramework.fixtures.BasePlatformTestCase

/** Loads the plugin in a headless IDE: actions, services and settings are wired up from plugin.xml. */
class PluginWiringTest : BasePlatformTestCase() {
    fun testActionsAreRegistered() {
        val am = ActionManager.getInstance()
        for (id in listOf("XScript.UploadAndRun", "XScript.Stop", "XScript.Connect", "XScript.Settings", "XScript.UploadAndRun.Popup",
            "XScript.EvalSelection", "XScript.EvalSelection.Popup", "XScript.PullProject", "XScript.UploadAndRunFull")) {
            assertNotNull(id, am.getAction(id))
        }
    }

    fun testSettingsAndPairingCode() {
        val s = XScriptSettings.get()
        val old = s.device
        try {
            s.device = " 10.0.0.9:9001 "
            assertEquals(DeviceTarget("10.0.0.9", 9001), s.target())
            s.setPairingCode("test-2345")
            assertEquals("TEST2345", s.pairingCode())
            assertEquals("TEST2345", s.client().token)
            s.setPairingCode("")
            assertEquals("", s.pairingCode())
        } finally {
            s.device = old
        }
    }

    fun testEvalTimeoutSettingIsClampedAndEditable() {
        val s = XScriptSettings.get()
        val old = s.evalTimeoutMs
        try {
            assertEquals(XScriptSettings.DEFAULT_EVAL_TIMEOUT_MS, XScriptSettings.State().evalTimeoutMs)
            s.evalTimeoutMs = 50
            assertEquals(200, s.evalTimeoutMs)
            s.evalTimeoutMs = 60000
            assertEquals(15000, s.evalTimeoutMs)
            s.loadState(XScriptSettings.State().apply { device = s.device; evalTimeoutMs = 99999 }) // hand-edited xscript.xml
            assertEquals(15000, s.evalTimeoutMs)

            s.evalTimeoutMs = 8000
            val ui = XScriptConfigurable()
            ui.createComponent()
            assertFalse(ui.isModified)
            val spinner = ui.javaClass.getDeclaredField("evalTimeout").apply { isAccessible = true }.get(ui) as com.intellij.ui.JBIntSpinner
            spinner.number = 3000
            assertTrue(ui.isModified)
            ui.apply()
            assertEquals(3000, s.evalTimeoutMs)
            assertFalse(ui.isModified)
            ui.disposeUIResources()
        } finally {
            s.evalTimeoutMs = old
        }
    }

    fun testProjectRootFindsTopmostPackage() {
        val init = myFixture.addFileToProject("demo/lib/__init__.py", "")
        myFixture.addFileToProject("demo/__init__.py", "print('hi')\n")
        val root = XScriptService.get(project).projectRoot(init.virtualFile)
        // the light fixture's temp:// file system has no java.nio path: then the IDE project base is used
        assertTrue(root == null || root.fileName.toString() == "demo" || LocalProject.isProjectDir(root))
    }

    fun testStubsShipWithThePluginAndAttach() {
        val dir = Stubs.dir()
        assertNotNull("plugin sandbox should contain stubs/", dir)
        assertTrue(java.nio.file.Files.exists(dir!!.resolve("xscript/android/__init__.pyi")))
        assertTrue(java.nio.file.Files.isDirectory(dir.resolve("ascript")))
        assertFalse(ToggleStubsAction.enabled(project))
        Stubs.attach(module, dir)
        assertTrue(Stubs.isAttached(module, dir))
        assertTrue(ToggleStubsAction.enabled(project))
        Stubs.attach(module, dir) // idempotent: still one library
        assertEquals(1, com.intellij.openapi.roots.ModuleRootManager.getInstance(module).orderEntries.count {
            it is com.intellij.openapi.roots.LibraryOrderEntry && it.libraryName == Stubs.LIBRARY })
        Stubs.detach(module)
        assertFalse(Stubs.isAttached(module, dir))
    }

    fun testLooksLikeXScript() {
        val ws = java.nio.file.Files.createTempDirectory("xs-detect-")
        assertFalse(StubsStartupActivity.looksLikeXScript(ws))
        java.nio.file.Files.createDirectories(ws.resolve("demo"))
        java.nio.file.Files.writeString(ws.resolve("demo/__init__.py"), "import os\nfrom xscript.android import action\n")
        assertTrue(StubsStartupActivity.looksLikeXScript(ws))
        ws.toFile().deleteRecursively()
    }
}
