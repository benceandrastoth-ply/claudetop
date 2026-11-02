import java.util.Properties

plugins {
    id("com.android.application")
}

// One version for every platform: the desktop app's package.json.
@Suppress("UNCHECKED_CAST")
val pkg = groovy.json.JsonSlurper().parse(rootProject.file("../package.json")) as Map<String, Any>
val appVersion = pkg["version"] as String
val (major, minor, patch) = appVersion.split(".").map { it.takeWhile(Char::isDigit).toInt() }

// The release key lives next to the project but never in git (see .gitignore).
val keyProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "app.claudetop"
    compileSdk = 37

    defaultConfig {
        applicationId = "app.claudetop"
        minSdk = 26
        targetSdk = 36
        versionCode = major * 10000 + minor * 100 + patch
        versionName = appVersion
    }

    signingConfigs {
        if (keyProps.containsKey("storeFile")) {
            create("release") {
                storeFile = rootProject.file(keyProps.getProperty("storeFile"))
                storePassword = keyProps.getProperty("storePassword")
                keyAlias = keyProps.getProperty("keyAlias")
                keyPassword = keyProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release")
        }
    }

    sourceSets {
        getByName("main") {
            assets.directories.add(layout.buildDirectory.dir("generated/claude").get().asFile.path)
        }
    }
}

// The little Claude itself is the desktop app's page (../src), with a shim in front of it that
// stands in for Electron.
val copyClaude = tasks.register<Sync>("copyClaude") {
    from(rootProject.file("../src")) {
        include("renderer.js", "style.css")
        into("claude")
    }
    from(rootProject.file("../src/index.html")) {
        into("claude")
        filter { line ->
            line.replace(
                "<script src=\"renderer.js\"></script>",
                "<link rel=\"stylesheet\" href=\"android.css\"><script src=\"android-shim.js\"></script><script src=\"renderer.js\"></script>",
            )
        }
    }
    into(layout.buildDirectory.dir("generated/claude"))
}

tasks.named("preBuild") { dependsOn(copyClaude) }
