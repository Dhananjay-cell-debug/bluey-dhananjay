package app.bluey

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import app.bluey.ui.BlueyRoot

class MainActivity : ComponentActivity() {
    private lateinit var model: BlueyModel

    private val askMic = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        model.micPermissionAnswered()
        if (!granted) model.showToast("Bluey needs the microphone to hear your questions. You can allow it in Settings.")
    }
    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        model = BlueyModel.get(this)
        model.hasMicPermission = { ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED }
        // His face fills the screen: no status bar, no navigation bar, and the screen stays awake.
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
        setContent {
            BlueyRoot(model, requestMic = { askMic.launch(Manifest.permission.RECORD_AUDIO) })
        }
        if (!model.hasMicPermission()) askMic.launch(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    override fun onStart() {
        super.onStart()
        model.start()
    }

    override fun onStop() {
        super.onStop()
        // Keep the link while a session runs (the mic keeps going in the background); otherwise rest.
        if (model.mode.value == Mode.ASLEEP && !isChangingConfigurations) model.stop()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) WindowInsetsControllerCompat(window, window.decorView).hide(WindowInsetsCompat.Type.systemBars())
    }
}
