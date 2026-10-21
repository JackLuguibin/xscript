import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType
import org.jetbrains.intellij.platform.gradle.TestFrameworkType
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("org.jetbrains.kotlin.jvm") version "2.3.0"
    id("org.jetbrains.intellij.platform") version "2.19.0"
}

group = "com.xscript"
version = providers.gradleProperty("pluginVersion").get()

repositories {
    mavenCentral()
    intellijPlatform { defaultRepositories() }
}

dependencies {
    intellijPlatform {
        // from the IntelliJ Maven repository (the installer listing is not needed and differs per OS)
        pycharmCommunity(providers.gradleProperty("platformVersion")) { useInstaller = false }
        bundledPlugin("PythonCore")
        testFramework(TestFrameworkType.Platform)
    }
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.opentest4j:opentest4j:1.3.0")
}

// The IDE runs on Java 21 from 2024.2 on; build bytecode for it whatever JDK runs Gradle (CI: 21, Mac: Android Studio's 25).
java {
    sourceCompatibility = JavaVersion.VERSION_21
    targetCompatibility = JavaVersion.VERSION_21
}
kotlin { compilerOptions { jvmTarget.set(JvmTarget.JVM_21) } }

intellijPlatform {
    pluginConfiguration {
        version = providers.gradleProperty("pluginVersion")
        ideaVersion {
            sinceBuild = providers.gradleProperty("sinceBuild")
            untilBuild = provider { null }
        }
    }
    pluginVerification {
        ides { create(IntelliJPlatformType.PyCharmCommunity, providers.gradleProperty("platformVersion")) }
    }
    // Not published to JetBrains Marketplace (needs the user's approval and account).
}

tasks.test {
    // scripts/mock_device.py lives at the repo root; the client tests start it when python3 is available.
    systemProperty("xscript.repo", rootDir.resolve("../..").canonicalPath)
    testLogging { events("failed"); exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL }
}
