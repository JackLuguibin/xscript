import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType
import org.jetbrains.intellij.platform.gradle.TestFrameworkType
import org.jetbrains.kotlin.gradle.dsl.JvmDefaultMode
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
kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_21)
        // Use the platform interfaces' own default methods instead of generating bridges that override them
        // (the bridges show up in the Plugin Verifier as internal / deprecated API usages).
        jvmDefault.set(JvmDefaultMode.NO_COMPATIBILITY)
    }
}

intellijPlatform {
    pluginConfiguration {
        version = providers.gradleProperty("pluginVersion")
        ideaVersion {
            sinceBuild = providers.gradleProperty("sinceBuild")
            untilBuild = provider { null }
        }
    }
    pluginVerification {
        ides {
            // the lowest supported line and a newer one, so a removed API shows up here before it does for users
            create(IntelliJPlatformType.PyCharmCommunity, providers.gradleProperty("platformVersion")) { useInstaller = false }
            create(IntelliJPlatformType.PyCharmCommunity, providers.gradleProperty("verifyAlsoVersion")) { useInstaller = false }
        }
        // Fail on API the platform marks internal (as JetBrains Marketplace would reject it), not just on breakage.
        failureLevel = listOf(
            org.jetbrains.intellij.platform.gradle.tasks.VerifyPluginTask.FailureLevel.COMPATIBILITY_PROBLEMS,
            org.jetbrains.intellij.platform.gradle.tasks.VerifyPluginTask.FailureLevel.INTERNAL_API_USAGES,
            org.jetbrains.intellij.platform.gradle.tasks.VerifyPluginTask.FailureLevel.INVALID_PLUGIN,
        )
    }
    // Not published to JetBrains Marketplace (needs the user's approval and account).
}

// The .pyi stubs that scripts/gen_stubs.py generates (ide/python-stubs) ship inside the plugin as <plugin>/stubs, the
// same files the VS Code extension bundles; the plugin points PyCharm at them instead of copying them into projects.
val stubsDir = rootDir.resolve("../python-stubs")
tasks.withType<org.jetbrains.intellij.platform.gradle.tasks.PrepareSandboxTask>().configureEach {
    val plugin = pluginName
    from(stubsDir) {
        include("xscript/**", "ascript/**")
        exclude("**/__pycache__/**")
        into(plugin.map { "$it/stubs" })
    }
}

// The Web IDE's basic checks (android/app/src/main/assets/tools) ship as /webide/ resources; LintEngine runs them in JCEF.
tasks.processResources {
    from(rootDir.resolve("../../android/app/src/main/assets/tools")) {
        include("editor-parse.js", "editor-symbols.js", "editor-docs.js")
        into("webide")
    }
}

// ./gradlew runIde -PrunIdeProject=/path/to/project opens a sandboxed PyCharm (build/idea-sandbox) on that folder.
tasks.runIde {
    providers.gradleProperty("runIdeProject").orNull?.let { args(it) }
    // -PrunIdeHeadlessConsent: skip the user-agreement / data-sharing dialogs in this throwaway sandbox (screenshots)
    if (providers.gradleProperty("runIdeHeadlessConsent").isPresent) {
        jvmArgs("-Djb.privacy.policy.text=<!--999.999-->", "-Djb.consents.confirmation.enabled=false", "-Didea.initially.ask.config=never", "-Didea.trust.all.projects=true")
    }
    // -PrunIdeScreenshotDemo=run|settings|eval|pull|projects|connect|capture|lint (-PrunIdeScreenshotConnect=<address> for connect / capture; XS_SHOT_CODE=<pairing code> in the environment for capture): ScreenshotDemoActivity drives one feature for docs screenshots
    // -PrunIdeScreenshotOut=<dir>: the demo also saves PNGs of the IDE window there (no screen-recording permission needed)
    providers.gradleProperty("runIdeScreenshotOut").orNull?.let { jvmArgs("-Dxscript.screenshotOut=$it") }
    providers.gradleProperty("runIdeScreenshotConnect").orNull?.let { jvmArgs("-Dxscript.screenshotConnect=$it") }
    providers.gradleProperty("runIdeScreenshotDemo").orNull?.let {
        jvmArgs("-Dxscript.screenshotDemo=$it", "-Dide.show.tips.on.startup.default.value=false", "-Didea.fatal.error.notification=disabled")
    }
    // capture: the sandbox keeps passwords in memory only, so the pairing code (XS_SHOT_CODE) never goes to the keychain
    if (providers.gradleProperty("runIdeScreenshotDemo").orNull == "capture") {
        val options = sandboxConfigDirectory.map { it.dir("options") }
        doFirst {
            val dir = options.get().asFile
            dir.mkdirs()
            dir.resolve("security.xml").writeText(
                "<application>\n  <component name=\"PasswordSafe\">\n    <option name=\"PROVIDER\" value=\"MEMORY_ONLY\" />\n  </component>\n</application>\n",
            )
        }
    }
}

tasks.test {
    // scripts/mock_device.py lives at the repo root; the client tests start it when python3 is available.
    systemProperty("xscript.repo", rootDir.resolve("../..").canonicalPath)
    testLogging { events("failed"); exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL }
}
