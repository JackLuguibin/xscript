// The IntelliJ Platform plugin asks for a JDK 21 toolchain; foojay downloads one into ~/.gradle when none is installed.
plugins {
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}

rootProject.name = "xscript-pycharm"
