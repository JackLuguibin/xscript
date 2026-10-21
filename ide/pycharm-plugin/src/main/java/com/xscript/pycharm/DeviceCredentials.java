package com.xscript.pycharm;

import com.intellij.credentialStore.CredentialAttributes;
import com.intellij.credentialStore.CredentialAttributesKt;

/**
 * Password-safe key for a device's pairing code.
 *
 * Written in Java on purpose: from Kotlin, {@code CredentialAttributes(service, user)} compiles to the
 * synthetic default-argument constructor (String, String, Class, boolean, int, DefaultConstructorMarker),
 * which 2025.1+ deprecates. Java binds to the plain (String, String) constructor present in 2024.2 and later.
 */
public final class DeviceCredentials {
    private DeviceCredentials() {}

    public static String serviceName(String host, int port) {
        return CredentialAttributesKt.generateServiceName("XScript", "device " + host + ":" + port);
    }

    public static CredentialAttributes attributes(String host, int port) {
        return new CredentialAttributes(serviceName(host, port), "xscript");
    }
}
