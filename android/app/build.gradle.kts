plugins {
    id("com.android.application")
    id("com.chaquo.python")
}

android {
    namespace = "com.xscript.app"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.xscript.app"
        minSdk = 26
        targetSdk = 34
        versionCode = 2
        versionName = "0.2.0"
        ndk {
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        aidl = true
    }
    packaging {
        resources.excludes += listOf("META-INF/*.kotlin_module", "META-INF/DEPENDENCIES")
    }
}

// Chaquopy ships OpenCV wheels up to CPython 3.10, and AScript projects lean on cv2/numpy,
// so the embedded interpreter is 3.10. The build machine needs a matching python3.10
// (scripts/build_android.sh finds one via `uv python find 3.10`).
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
        }
        pyc {
            src = false
        }
    }
    sourceSets {
        getByName("main") {
            srcDir("../../python-runtime")
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("org.nanohttpd:nanohttpd:2.3.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.google.mlkit:text-recognition-chinese:16.0.1")
}
