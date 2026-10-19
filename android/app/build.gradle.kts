import java.util.Properties

plugins {
    id("com.android.application")
    id("com.chaquo.python")
}

/*
 * APK 打包: `backend/xscript_pack.py` builds a standalone app from one project by passing
 * -Pxscript.pack=<pack.properties>. Without it this is the regular XScript developer app.
 *
 * pack.properties keys:
 *   project_dir, project_name, app_id, app_name, version_name, version_code, icon (png),
 *   license_pubkey (base64 DER, enables 卡密), license_server, cloud_url, cloud_group,
 *   dev_server (true/false), autostart (true/false), keystore / keystore_password /
 *   key_alias / key_password (release signing), update_server / update_channel /
 *   update_pubkey / script_code (热更新)
 */
val packFile: File? = (project.findProperty("xscript.pack") as String?)?.let { file(it) }
val pack: Properties = Properties().apply { packFile?.takeIf { it.isFile }?.reader(Charsets.UTF_8)?.use { load(it) } }
val packed = packFile != null
// Private signing credentials stay outside version control (keys/ is ignored).
val releaseSigningFile = rootProject.file(
    (project.findProperty("xscript.signingFile") as String?) ?: "../keys/release.properties",
)
val releaseSigning = Properties().apply {
    releaseSigningFile.takeIf { it.isFile }?.reader(Charsets.UTF_8)?.use { load(it) }
}
// Each packed app builds into its own directory, so it never mixes outputs with the
// developer app (or with another packed app) and incremental builds stay valid.
if (packed) layout.buildDirectory.set(file("build-pack/" + pack.getProperty("app_id", "app").trim()))
fun packProp(key: String, default: String = ""): String = pack.getProperty(key, default).trim()
fun String.kotlinQuoted(): String = "\"" + replace("\\", "\\\\").replace("\"", "\\\"").replace("$", "\\$") + "\""

// Generated resources and assets for a packed build: the bundled project, app name, icon.
// A plain File (AGP 9 rejects Provider source dirs); preBuild depends on preparePack below.
val packGen: File = file("build-pack-gen/" + pack.getProperty("app_id", "app").trim())

android {
    namespace = "com.xscript.app"
    compileSdk = 37

    defaultConfig {
        applicationId = if (packed) packProp("app_id") else "com.xscript.app"
        minSdk = 26
        targetSdk = 34
        versionCode = if (packed) packProp("version_code", "1").toInt() else 9
        versionName = if (packed) packProp("version_name", "1.0.0") else "0.3.0"
        ndk {
            abiFilters += (packProp("abis").ifEmpty { "arm64-v8a,x86_64" }).split(',').map { it.trim() }.filter { it.isNotEmpty() }
        }
        buildConfigField("boolean", "PACKAGED", packed.toString())
        buildConfigField("String", "PACK_PROJECT", packProp("project_name").kotlinQuoted())
        buildConfigField("boolean", "PACK_AUTOSTART", packProp("autostart", "false").toBoolean().toString())
        buildConfigField("String", "PACK_CLOUD_URL", packProp("cloud_url").kotlinQuoted())
        buildConfigField("String", "PACK_CLOUD_GROUP", packProp("cloud_group").kotlinQuoted())
        buildConfigField("boolean", "PACK_DEV_SERVER", packProp("dev_server", if (packed) "false" else "true").toBoolean().toString())
        val pub = packProp("license_pubkey")
        buildConfigField("boolean", "LICENSE_REQUIRED", (pub.isNotEmpty()).toString())
        buildConfigField("String", "LICENSE_PUBKEY", pub.kotlinQuoted())
        buildConfigField("String", "LICENSE_SERVER", packProp("license_server").kotlinQuoted())
        // 热更新: newer published versions of the bundled 小程序 (UpdateChecker).
        // 公告 / APK 强制更新 (AppOps): the server whose /pub/app-notices and /pub/app-update the app asks.
        buildConfigField("String", "OPS_SERVER", packProp("ops_server").kotlinQuoted())
        buildConfigField("String", "UPDATE_SERVER", packProp("update_server").kotlinQuoted())
        buildConfigField("String", "UPDATE_CHANNEL", packProp("update_channel").kotlinQuoted())
        buildConfigField("String", "UPDATE_PUBKEY", packProp("update_pubkey").kotlinQuoted())
        buildConfigField("int", "PACK_SCRIPT_CODE", packProp("script_code", "0").ifEmpty { "0" }.toInt().toString())
        manifestPlaceholders["linkScheme"] = if (packed) packProp("app_id").lowercase() else "xscript"
        manifestPlaceholders["appLabel"] = if (packed) "@string/pack_app_name" else "@string/app_name"
        manifestPlaceholders["appIcon"] =
            if (packed && packProp("icon").isNotEmpty()) "@drawable/ic_pack" else "@drawable/ic_launcher"
    }

    signingConfigs {
        if (!packed && releaseSigningFile.isFile) {
            create("production") {
                listOf("storeFile", "storePassword", "keyAlias", "keyPassword").forEach {
                    require(!releaseSigning.getProperty(it).isNullOrBlank()) { "Missing release signing property: $it" }
                }
                storeFile = releaseSigningFile.parentFile.resolve(releaseSigning.getProperty("storeFile"))
                storePassword = releaseSigning.getProperty("storePassword")
                keyAlias = releaseSigning.getProperty("keyAlias")
                keyPassword = releaseSigning.getProperty("keyPassword")
            }
        }
        if (packed && packProp("keystore").isNotEmpty()) {
            create("pack") {
                storeFile = file(packProp("keystore"))
                storePassword = packProp("keystore_password")
                keyAlias = packProp("key_alias")
                keyPassword = packProp("key_password")
            }
        }
    }

    buildTypes {
        release {
            // R8: shrink and optimize the libraries (the app's own classes are kept, see proguard-rules.pro),
            // then drop the resources nothing references any more.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            signingConfigs.findByName("pack")?.let { signingConfig = it }
            if (!packed) signingConfigs.findByName("production")?.let { signingConfig = it }
        }
    }

    sourceSets {
        getByName("main") {
            if (packed) {
                assets.srcDir(File(packGen, "assets"))
                res.srcDir(File(packGen, "res"))
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        aidl = true
        buildConfig = true
    }
    packaging {
        resources.excludes += listOf("META-INF/*.kotlin_module", "META-INF/DEPENDENCIES")
    }
}

// Copy the project into assets/pack/<name>/ and write the label / icon resources.
val preparePack by tasks.registering {
    val out = packGen
    val src = packProp("project_dir")
    val name = packProp("project_name")
    val label = packProp("app_name", name)
    val icon = packProp("icon")
    inputs.property("pack", pack.toString())
    if (src.isNotEmpty()) inputs.dir(src)
    outputs.dir(out)
    doLast {
        val root = out
        root.deleteRecursively()
        val dest = File(root, "assets/pack/$name")
        copy {
            from(src)
            into(dest)
            // Top-level .pyc files stay: 代码保护 builds (xscript_pack.py --protect) ship only those.
            exclude("**/__pycache__/**", "**/.git/**", "**/.DS_Store", "**/.idea/**", "**/.vscode/**")
        }
        val values = File(root, "res/values").apply { mkdirs() }
        val esc = label.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("'", "\\'").replace("\"", "\\\"")
        File(values, "pack.xml").writeText(
            "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<resources>\n    <string name=\"pack_app_name\">$esc</string>\n</resources>\n",
        )
        if (icon.isNotEmpty() && file(icon).isFile) {
            val dir = File(root, "res/drawable-nodpi").apply { mkdirs() }
            file(icon).copyTo(File(dir, "ic_pack.png"), overwrite = true)
        }
    }
}
if (packed) {
    tasks.named("preBuild") { dependsOn(preparePack) }
}

// Chaquopy ships OpenCV wheels up to CPython 3.10, and AScript projects lean on cv2/numpy,
// so the embedded interpreter is 3.10. The build machine needs a matching python3.10
// (android/build.sh finds one via `uv python find 3.10`).
val buildPy: String = System.getenv("XSCRIPT_BUILD_PYTHON")
    ?: (project.findProperty("xscript.buildPython") as String?)
    ?: "python3.10"

chaquopy {
    defaultConfig {
        version = "3.10"
        buildPython(buildPy)
        pip {
            install("numpy==1.23.3")
            install("opencv-python==4.5.1.48")
            install("pillow==9.2.0")
            install("pyyaml==6.0.3")
            install("requests==2.32.3")
            // Version parsing / markers for the runtime installer (xscript.android.pip).
            install("packaging==24.2")
            // Upstream universal wheel: no Android native extensions or adapter subprocess.
            install(rootProject.file("wheels/debugpy-1.8.22-py2.py3-none-any.whl").absolutePath)
            // Packed apps can pre-install their requirements.txt at build time (pack key `pip`).
            packProp("pip").split(',').map { it.trim() }.filter { it.isNotEmpty() }.forEach { install(it) }
        }
        pyc {
            src = false
        }
    }
    sourceSets {
        getByName("main") {
            srcDir("../python-runtime")
        }
    }
}

// R8KeepRulesTest reads the keep rules, this script and the Python runtime; declare them so edits re-run it.
tasks.withType<Test>().configureEach {
    inputs.file("proguard-rules.pro").withPathSensitivity(PathSensitivity.RELATIVE)
    inputs.file("build.gradle.kts").withPathSensitivity(PathSensitivity.RELATIVE)
    inputs.dir("../python-runtime").withPathSensitivity(PathSensitivity.RELATIVE)
}

dependencies {
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("org.nanohttpd:nanohttpd:2.3.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.google.mlkit:text-recognition-chinese:16.0.1")
    // YOLO / PaddleOCR inference (xscript.android.onnx). Only the ABIs in abiFilters are packaged.
    implementation("com.microsoft.onnxruntime:onnxruntime-android:1.22.0")

    testImplementation("junit:junit:4.13.2")
    // Real org.json on the JVM; the android.jar stub throws "not mocked".
    testImplementation("org.json:json:20240303")
}
