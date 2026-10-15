package com.xscript.app.license

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Tokens below were made by `backend/xscript_server/licensing.py issue` (Python `cryptography`). */
class LicenseTokenTest {
    private val pub = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEkZj79PhZcDuIk5sR6DSO1qgFYAwzdLbo6/wdL1D1JTkh0XZrAxkAk9ZyfJNMeVpsbzZPUOK1aM/QJKZFb34tXg=="

    // device dev123, app com.example.x, 30 days
    private val bound = "eyJhcHAiOiJjb20uZXhhbXBsZS54IiwiY2FyZCI6IlhTLVNYR0gtNDJGQy1LN0hVLUVYR0siLCJkZXZpY2UiOiJkZXYxMjMiLCJleHAiOjE3OTMzNjYxNDksImlhdCI6MTc5MDc3NDE0OX0." +
        "MEYCIQDddRjXLhzUr3gtJu1XsEeN40VpV0URs9tGi9uA2wKP1QIhAONWef60Rp4Q0r1enCeL5VRll_arPhXEnUgch6hSVGQ3"

    // device *, app *, permanent
    private val open = "eyJhcHAiOiIqIiwiY2FyZCI6IlhTLVBVQTMtWlhEQy0yM0dZLVJRR1MiLCJkZXZpY2UiOiIqIiwiZXhwIjowLCJpYXQiOjE3OTA3NzQxNDl9." +
        "MEUCIFK2bdJpS_3zS1gwFDEm5EgyqAZ3XuyCj4ClWGY6bqUZAiEA8e44rtiO_-Y7GOHc9W2QXRNWqq3_Ildnwbc_mJTik5s"

    private val key = LicenseToken.publicKey(pub)!!

    @Test
    fun verifiesPythonSignedToken() {
        val p = LicenseToken.verify(key, bound)
        assertNotNull(p)
        assertEquals("XS-SXGH-42FC-K7HU-EXGK", p!!.getString("card"))
        assertEquals(1793366149L, p.getLong("exp"))
        assertTrue(LicenseToken.matches(p, "dev123", "com.example.x"))
        assertFalse(LicenseToken.matches(p, "other", "com.example.x"))
        assertFalse(LicenseToken.matches(p, "dev123", "com.other"))
    }

    @Test
    fun wildcardToken() {
        val p = LicenseToken.verify(key, open)!!
        assertEquals(0L, p.getLong("exp"))
        assertTrue(LicenseToken.matches(p, "anything", "any.app"))
    }

    @Test
    fun rejectsTampering() {
        val (body, sig) = bound.split('.')
        // Swap in the payload of the wildcard token: the signature no longer matches.
        assertNull(LicenseToken.verify(key, open.substringBefore('.') + "." + sig))
        assertNull(LicenseToken.verify(key, body + "." + sig.dropLast(4) + "AAAA"))
        assertNull(LicenseToken.verify(key, "garbage"))
        assertNull(LicenseToken.publicKey("not a key"))
    }

    private val utc = java.util.TimeZone.getTimeZone("UTC")
    private val day = 86400L

    @Test
    fun describesFirstActivationAndRenewal() {
        val exp = 1_800_000_000L // 2027-01-15 08:00 UTC
        assertEquals("已激活，有效至 2027-01-15 08:00", LicenseToken.describeActivation(null, exp, utc))
        assertEquals("续期成功，有效至 2027-01-15 08:00（延长 30 天）", LicenseToken.describeActivation(exp - 30 * day, exp, utc))
        assertEquals("续期成功，有效至 2027-01-15 08:00（延长 1 天）", LicenseToken.describeActivation(exp - day + 600, exp, utc))
    }

    @Test
    fun describesPermanentAndOddCases() {
        assertEquals("已激活（永久）", LicenseToken.describeActivation(null, 0, utc))
        assertEquals("续期成功，已升级为永久", LicenseToken.describeActivation(1_800_000_000L, 0, utc))
        assertEquals("已激活，有效至 2027-01-15 08:00（原授权是永久的）", LicenseToken.describeActivation(0, 1_800_000_000L, utc))
        // Not later than what the app already had: plain activation, no claim of an extension.
        assertEquals("已激活，有效至 2027-01-15 08:00", LicenseToken.describeActivation(1_800_000_000L + day, 1_800_000_000L, utc))
    }
}
