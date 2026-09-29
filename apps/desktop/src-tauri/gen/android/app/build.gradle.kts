import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// Local release builds can be signed with UwUMail's key. CI builds unsigned and signs in a separate step,
// so the key is never around while third-party build code runs.
val keystorePath: String? = System.getenv("UWUMAIL_ANDROID_KEYSTORE")

android {
    compileSdk = 36
    namespace = "app.uwumail"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "app.uwumail"
        minSdk = 29
        targetSdk = 36
        versionCode = (System.getenv("UWUMAIL_ANDROID_VERSION_CODE")
            ?: tauriProperties.getProperty("tauri.android.versionCode", "1")).toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        if (keystorePath != null) {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = System.getenv("UWUMAIL_ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("UWUMAIL_ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("UWUMAIL_ANDROID_KEY_PASSWORD")
                storeType = "pkcs12"
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            isMinifyEnabled = true
            if (keystorePath != null) {
                signingConfig = signingConfigs.getByName("release")
            }
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.core:core-splashscreen:1.0.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    // UnifiedPush: registration with the distributor, Web Push keys and decryption (RFC 8291).
    // 3.0.10 is the newest release whose Kotlin standard library (2.0) the Kotlin plugin here (1.9)
    // can still read; 3.1 and later bring Kotlin 2.2.
    implementation("org.unifiedpush.android:connector:3.0.10")
    // Text in mail pictures (PictureText.kt): ML Kit's recognizer from Google Play services, whose
    // model Play services downloads, a few hundred KB in the APK instead of several MB per ABI for
    // the bundled model. Without Play services the feature is off.
    implementation("com.google.android.gms:play-services-mlkit-text-recognition:19.0.1")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

// The connector brings Tink for Java, with the full Protobuf and an optional HTTP client that isn't
// there. Tink's Android build of the same version is made for R8 (as the connector's docs suggest).
configurations.configureEach {
    val tink = "com.google.crypto.tink:tink-android:1.17.0"
    resolutionStrategy {
        force(tink)
        dependencySubstitution {
            substitute(module("com.google.crypto.tink:tink")).using(module(tink))
        }
    }
}

apply(from = "tauri.build.gradle.kts")
