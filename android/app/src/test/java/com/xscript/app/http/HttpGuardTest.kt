package com.xscript.app.http

import com.xscript.app.http.HttpGuard.Verdict
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HttpGuardTest {
    private val code = "ABCDEFGH"

    private fun v(method: String, path: String, vararg h: Pair<String, String>, required: Boolean = true) =
        HttpGuard.verdict(HttpGuard.Check(method, path, mapOf("host" to "192.168.1.5:9860", *h), code, required))

    @Test
    fun unpairedEvalIsRefused() {
        assertEquals(Verdict.UNAUTHORIZED, v("POST", "/eval"))
        assertEquals(Verdict.UNAUTHORIZED, v("POST", "/eval", "authorization" to "Bearer WRONGCODE"))
        assertEquals(Verdict.UNAUTHORIZED, v("GET", "/projects"))
        assertEquals(Verdict.UNAUTHORIZED, v("POST", "/capture/request"))
        assertEquals(Verdict.UNAUTHORIZED, v("GET", "/screen/stream"))
        assertEquals(Verdict.UNAUTHORIZED, v("GET", "/tools/"))
        assertEquals(Verdict.UNAUTHORIZED, v("GET", "/tools/ui/editor.html"))
    }

    @Test
    fun tokenFromHeaderOrCookie() {
        assertEquals(Verdict.OK, v("POST", "/eval", "authorization" to "Bearer ABCD-EFGH"))
        assertEquals(Verdict.OK, v("POST", "/eval", "authorization" to "bearer abcdefgh"))
        assertEquals(Verdict.OK, v("POST", "/eval", "x-xscript-token" to "abcd-efgh"))
        assertEquals(Verdict.OK, v("GET", "/screen/stream", "cookie" to "theme=dark; xs_pair=ABCDEFGH"))
        assertEquals(Verdict.UNAUTHORIZED, v("GET", "/screen", "cookie" to "xs_pairx=ABCDEFGH"))
    }

    @Test
    fun publicRoutes() {
        assertEquals(Verdict.OK, v("GET", "/status"))
        assertEquals(Verdict.OK, v("GET", "/pair"))
        assertEquals(Verdict.OK, v("POST", "/pair"))
        assertEquals(Verdict.OK, v("GET", "/tools/ui/tools.css"))
        assertEquals(Verdict.OK, v("GET", "/tools/ui/common.js"))
        assertEquals(Verdict.UNAUTHORIZED, v("PUT", "/status"))
        assertEquals(Verdict.UNAUTHORIZED, v("POST", "/tools/ui/common.js"))
    }

    @Test
    fun pairingOffIsOpenButStillChecksHostAndOrigin() {
        assertEquals(Verdict.OK, v("POST", "/eval", required = false))
        assertEquals(Verdict.BAD_ORIGIN, v("POST", "/eval", "origin" to "http://evil.example", required = false))
        assertEquals(Verdict.BAD_HOST, HttpGuard.verdict(HttpGuard.Check("POST", "/eval", mapOf("host" to "rebind.evil.example:9860"), code, false)))
    }

    @Test
    fun hostAllowlistStopsDnsRebinding() {
        assertTrue(HttpGuard.hostAllowed("192.168.1.5:9860"))
        assertTrue(HttpGuard.hostAllowed("127.0.0.1"))
        assertTrue(HttpGuard.hostAllowed("localhost:9861"))
        assertTrue(HttpGuard.hostAllowed("[::1]:9860"))
        assertTrue(HttpGuard.hostAllowed("[fe80::1%25wlan0]:9860"))
        assertTrue(HttpGuard.hostAllowed(null))
        assertFalse(HttpGuard.hostAllowed("attacker.example:9860"))
        assertFalse(HttpGuard.hostAllowed("192.168.1.5.nip.io:9860"))
        assertFalse(HttpGuard.hostAllowed("999.1.1.1"))
        assertFalse(HttpGuard.hostAllowed("1.2.3.4:abc"))
        assertFalse(HttpGuard.hostAllowed("[::1]x"))
        assertFalse(HttpGuard.hostAllowed("localhost.evil.example"))
    }

    @Test
    fun originMustBeTheDeviceItself() {
        assertTrue(HttpGuard.originAllowed(null, "192.168.1.5:9860"))
        assertTrue(HttpGuard.originAllowed("http://192.168.1.5:9860", "192.168.1.5:9860"))
        assertFalse(HttpGuard.originAllowed("http://192.168.1.5:9861", "192.168.1.5:9860"))
        assertFalse(HttpGuard.originAllowed("https://evil.example", "192.168.1.5:9860"))
        assertFalse(HttpGuard.originAllowed("null", "192.168.1.5:9860"))
        assertFalse(HttpGuard.originAllowed("http://192.168.1.5:9860", null))
        assertEquals(Verdict.BAD_ORIGIN, v("POST", "/eval", "origin" to "http://evil.example", "authorization" to "Bearer ABCDEFGH"))
    }

    @Test
    fun pagesRedirectInsteadOf401() {
        assertTrue(HttpGuard.isPage("GET", "/"))
        assertTrue(HttpGuard.isPage("GET", "/tools/"))
        assertTrue(HttpGuard.isPage("GET", "/tools/ui/mirror.html"))
        assertTrue(HttpGuard.isPage("GET", "/website/src/screen.html"))
        assertFalse(HttpGuard.isPage("GET", "/projects"))
        assertFalse(HttpGuard.isPage("POST", "/tools/"))
    }

    @Test
    fun jsonContentType() {
        assertTrue(HttpGuard.isJson("application/json"))
        assertTrue(HttpGuard.isJson("application/json; charset=utf-8"))
        assertTrue(HttpGuard.isJson("Application/JSON"))
        assertTrue(HttpGuard.isJson("application/problem+json"))
        assertFalse(HttpGuard.isJson("text/plain"))
        assertFalse(HttpGuard.isJson("application/x-www-form-urlencoded"))
        assertFalse(HttpGuard.isJson("multipart/form-data; boundary=x"))
        assertFalse(HttpGuard.isJson(""))
        assertFalse(HttpGuard.isJson(null))
    }

    @Test
    fun jsonBodyNeedsJsonContentType() {
        fun req(ct: String?) = ApiRouter.Request("POST", "/eval", emptyMap(), ApiRouter.Body.of("{\"code\":\"1\"}".toByteArray()), contentType = ct)
        assertEquals("1", req("application/json").json().getString("code"))
        assertEquals("cloud relay has no content type", "1", req(null).json().getString("code"))
        try {
            req("text/plain").json()
            throw AssertionError("text/plain JSON must be refused")
        } catch (e: ApiRouter.UnsupportedMediaType) {
            assertEquals(415, ApiRouter.errorReply(e).status)
        }
        assertEquals(0, ApiRouter.Request("POST", "/x", emptyMap(), ApiRouter.Body.EMPTY, contentType = "").json().length())
    }

    @Test
    fun codesCompareNormalized() {
        assertTrue(HttpGuard.matches("abcd-efgh", code))
        assertTrue(HttpGuard.matches(" ABCD EFGH ", code))
        assertFalse(HttpGuard.matches("", code))
        assertFalse(HttpGuard.matches("ABCDEFG", code))
        assertFalse(HttpGuard.matches("ABCDEFGH", ""))
        assertEquals("ABCDEFGH", HttpGuard.cookie("a=1; xs_pair=ABCDEFGH", "xs_pair"))
    }

    @Test
    fun generatedCodesAreReadable() {
        repeat(200) {
            val c = Pairing.generate()
            assertEquals(Pairing.LENGTH, c.length)
            assertTrue(c.all { it in Pairing.ALPHABET })
        }
        assertEquals("ABCD-EFGH", Pairing.display("ABCDEFGH"))
        assertFalse(Pairing.ALPHABET.any { it in "01OIL" })
    }

    @Test
    fun throttleLocksOutGuessing() {
        val t = Pairing.Throttle
        t.reset()
        repeat(Pairing.Throttle.MAX_FAILS - 1) { t.fail("10.0.0.9", 1_000L) }
        assertFalse(t.blocked("10.0.0.9", 1_000L))
        t.fail("10.0.0.9", 1_000L)
        assertTrue(t.blocked("10.0.0.9", 2_000L))
        assertFalse("other clients unaffected", t.blocked("10.0.0.8", 2_000L))
        assertFalse("window passes", t.blocked("10.0.0.9", 1_000L + Pairing.Throttle.WINDOW_MS + 1))
        t.reset()
    }
}
