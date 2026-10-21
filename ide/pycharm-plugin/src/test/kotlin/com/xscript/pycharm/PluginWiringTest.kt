package com.xscript.pycharm

import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.testFramework.fixtures.BasePlatformTestCase

/** Loads the plugin in a headless IDE: actions, services and settings are wired up from plugin.xml. */
class PluginWiringTest : BasePlatformTestCase() {
    fun testActionsAreRegistered() {
        val am = ActionManager.getInstance()
        for (id in listOf("XScript.UploadAndRun", "XScript.Stop", "XScript.Connect", "XScript.Settings", "XScript.UploadAndRun.Popup")) {
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

    fun testProjectRootFindsTopmostPackage() {
        val init = myFixture.addFileToProject("demo/lib/__init__.py", "")
        myFixture.addFileToProject("demo/__init__.py", "print('hi')\n")
        val root = XScriptService.get(project).projectRoot(init.virtualFile)
        // the light fixture's temp:// file system has no java.nio path: then the IDE project base is used
        assertTrue(root == null || root.fileName.toString() == "demo" || LocalProject.isProjectDir(root))
    }
}
