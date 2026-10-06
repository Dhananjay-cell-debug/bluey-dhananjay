plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "app.bluey"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.bluey"
        minSdk = 26
        targetSdk = 35
        versionCode = 2
        versionName = "1.1.0"
    }

    signingConfigs {
        create("release") {
            // A local signing key (made by scripts/build-android.sh) so the APK installs directly.
            storeFile = file(System.getenv("BLUEY_KEYSTORE") ?: "../bluey.keystore")
            storePassword = System.getenv("BLUEY_KEYSTORE_PASSWORD") ?: "bluey-local"
            keyAlias = "bluey"
            keyPassword = System.getenv("BLUEY_KEYSTORE_PASSWORD") ?: "bluey-local"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName("release")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true; buildConfig = true }

    // "lite" has no Accessibility service (so Google Play Protect lets it install); "full" can also use the phone for you.
    flavorDimensions += "mode"
    productFlavors {
        create("lite") { dimension = "mode"; buildConfigField("boolean", "HANDS", "false") }
        create("full") { dimension = "mode"; buildConfigField("boolean", "HANDS", "true") }
    }
    testOptions { unitTests.isReturnDefaultValues = true }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
