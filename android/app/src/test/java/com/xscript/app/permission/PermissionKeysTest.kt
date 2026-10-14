package com.xscript.app.permission

import org.junit.Assert.*
import org.junit.Test

class PermissionKeysTest {
    @Test fun aliasesResolveToTheSameGrant() {
        assertEquals("android.permission.READ_SMS", PermissionKeys.normalize("sms"))
        assertEquals("accessibility", PermissionKeys.normalize("accessibility_service"))
        assertEquals("overlay", PermissionKeys.normalize("android.permission.SYSTEM_ALERT_WINDOW"))
        assertEquals("android.permission.ACCESS_FINE_LOCATION", PermissionKeys.normalize(" location "))
        assertEquals("unknown", PermissionKeys.normalize("unknown"))
    }

    @Test fun preciseLocationRequestsBothPermissions() {
        assertArrayEquals(arrayOf("android.permission.ACCESS_COARSE_LOCATION", "android.permission.ACCESS_FINE_LOCATION"),
            PermissionKeys.runtimeBatch("android.permission.ACCESS_FINE_LOCATION"))
        assertArrayEquals(arrayOf("android.permission.READ_SMS"), PermissionKeys.runtimeBatch("android.permission.READ_SMS"))
    }

    @Test fun resultCodesMatchInspectedPythonDocumentation() {
        assertEquals(1, PermissionKeys.GRANTED)
        assertEquals(0, PermissionKeys.DENIED)
        assertEquals(-1, PermissionKeys.TIMEOUT)
        assertEquals(-2, PermissionKeys.UNSUPPORTED)
    }
}
