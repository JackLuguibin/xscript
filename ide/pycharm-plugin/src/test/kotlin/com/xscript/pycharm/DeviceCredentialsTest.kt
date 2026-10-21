package com.xscript.pycharm

import com.intellij.credentialStore.CredentialAttributes
import com.intellij.credentialStore.generateServiceName
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class DeviceCredentialsTest {
    /** Pairing codes saved by earlier versions must still be found: same service name and user name as before. */
    @Test
    fun keyIsUnchangedFromPreviousVersions() {
        @Suppress("DEPRECATION")
        val old = CredentialAttributes(generateServiceName("XScript", "device 192.168.1.5:9096"), "xscript")
        val now = DeviceCredentials.attributes("192.168.1.5", 9096)
        assertEquals(old.serviceName, now.serviceName)
        assertEquals(old.userName, now.userName)
        assertEquals("IntelliJ Platform XScript — device 192.168.1.5:9096", now.serviceName)
    }

    @Test
    fun eachDeviceHasItsOwnKey() {
        assertNotEquals(DeviceCredentials.serviceName("10.0.0.2", 9096), DeviceCredentials.serviceName("10.0.0.2", 9097))
        assertEquals("IntelliJ Platform XScript — device ::1:9096", DeviceCredentials.serviceName("::1", 9096))
    }
}
