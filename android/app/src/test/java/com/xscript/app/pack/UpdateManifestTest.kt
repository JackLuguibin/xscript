package com.xscript.app.pack

import com.xscript.app.license.LicenseToken
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/** Manifests below were signed by backend/xscript_server/licensing.py (the /pub/update signer). */
class UpdateManifestTest {
    private val key = LicenseToken.publicKey(
        "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEPYQ6kWFD6O2ZTFhiSn38+34kholDEfZhyFgk4bSQERz0hmWf2M116eowGcpSz7MR7FX3PjQ5LyVlImA6phZlZg==",
    )!!

    private val manifest = "eyJjaGFubmVsIjoiY2hfdGVzdCIsImlhdCI6MTc5MDAwMDAwMCwicHJvamVjdCI6ImdvbGQiLCJzaGEyNTYiOiJhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhIiwic2l6ZSI6MTAsInZlcnNpb24iOiIxLjAuMSIsInZlcnNpb25fY29kZSI6Mn0." +
        "MEUCIQDZlfTZzHh1QSYU4KcCalWiRMaOAimmc2FE_EjlZMobogIgT-ugCkbEYM6rekiq5HpdL448jaBgJ-9GURnZO7yYN-k"

    // Same key, channel ch_other.
    private val otherChannel = "eyJjaGFubmVsIjoiY2hfb3RoZXIiLCJpYXQiOjE3OTAwMDAwMDAsInByb2plY3QiOiJnb2xkIiwic2hhMjU2IjoiYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYSIsInNpemUiOjEwLCJ2ZXJzaW9uIjoiMS4wLjEiLCJ2ZXJzaW9uX2NvZGUiOjJ9." +
        "MEQCIAEB9vC_8so-LWbafWrZCnB7osm6ReNCEQmT6ZLppJmGAiAPAypug0ITfO8KJyvSSawBmhmTEYxE3tEj8li3QD04mA"

    @Test
    fun acceptsSignedManifestForOwnChannel() {
        val info = UpdateManifest.verify(key, manifest, "ch_test", "gold")
        assertNotNull(info)
        assertEquals(2, info!!.code)
        assertEquals("1.0.1", info.version)
        assertEquals("a".repeat(64), info.sha256)
    }

    @Test
    fun rejectsOtherChannelProjectOrTampering() {
        assertNull(UpdateManifest.verify(key, otherChannel, "ch_test", "gold"))
        assertNull(UpdateManifest.verify(key, manifest, "ch_test", "other_project"))
        val (body, sig) = manifest.split('.')
        assertNull(UpdateManifest.verify(key, otherChannel.substringBefore('.') + "." + sig, "ch_other", "gold"))
        assertNull(UpdateManifest.verify(key, body + "." + sig.dropLast(4) + "AAAA", "ch_test", "gold"))
    }

    @Test
    fun sha256Hex() {
        assertEquals(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            UpdateManifest.sha256("abc".toByteArray()),
        )
    }
}
