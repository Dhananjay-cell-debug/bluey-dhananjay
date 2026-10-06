package app.bluey

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import app.bluey.link.PcLink
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * Keeps the installed Bluey in step with the Bluey.apk on your PC. When the PC offers a newer version (over the
 * encrypted link, with the file's SHA-256), the phone downloads it from the PC on your Wi-Fi, checks the hash and the
 * Android installer does the rest; Bluey confirms its own install dialog. Only an update signed with the same key can
 * replace the app, so nobody else's file can be installed this way.
 */
class Updater(private val context: Context, private val link: PcLink) {
    private val main = Handler(Looper.getMainLooper())
    private val prefs = context.getSharedPreferences("updater", Context.MODE_PRIVATE)
    private val _status = MutableStateFlow<String?>(null)
    /** What to tell you right now ("Updating Bluey…"), or null. */
    val status: StateFlow<String?> = _status
    private val _needsPermission = MutableStateFlow(false)
    /** Android wants a one-time "Allow from this source" before Bluey may install its own updates. */
    val needsPermission: StateFlow<Boolean> = _needsPermission
    @Volatile private var busy = false
    private var offer: JSONObject? = null

    private fun report(state: String, detail: String = "") {
        main.post { link.send("updateStatus", "state" to state, "detail" to detail) }
    }

    /** Called after each connection: tells the PC if we just finished an update. */
    fun connected() {
        val target = prefs.getInt("target", 0)
        if (target > 0 && BuildConfig.VERSION_CODE >= target) {
            prefs.edit().remove("target").apply()
            _status.value = null
            report("installed", BuildConfig.VERSION_NAME)
        }
    }

    fun offered(m: JSONObject) {
        val code = m.optInt("versionCode", 0)
        if (code <= BuildConfig.VERSION_CODE || busy) return
        offer = m
        start()
    }

    /** After you allow installs from Bluey in Settings, carry on. */
    fun resume() { if (offer != null && !busy && _needsPermission.value) start() }

    fun openPermission() {
        runCatching {
            context.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }

    private fun start() {
        val m = offer ?: return
        if (!context.packageManager.canRequestPackageInstalls()) {
            _needsPermission.value = true
            _status.value = "A new Bluey is ready. Allow Bluey to update itself (one time)."
            report("needs-permission")
            return
        }
        _needsPermission.value = false
        busy = true
        val name = m.optString("versionName")
        _status.value = "Downloading Bluey $name…"
        report("downloading", name)
        Thread {
            try {
                val pc = link.current.value ?: throw IllegalStateException("PC not found")
                val file = File(context.cacheDir, "bluey-update.apk")
                val conn = URL("http://${pc.host}:${pc.port}${m.optString("path", "/Bluey.apk")}").openConnection() as HttpURLConnection
                conn.connectTimeout = 5000
                conn.readTimeout = 20000
                val digest = MessageDigest.getInstance("SHA-256")
                var total = 0L
                conn.inputStream.use { input ->
                    file.outputStream().use { out ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            out.write(buf, 0, n)
                            digest.update(buf, 0, n)
                            total += n
                        }
                    }
                }
                val sha = digest.digest().joinToString("") { "%02x".format(it) }
                if (total != m.optLong("size") || !sha.equals(m.optString("sha256"), true)) throw IllegalStateException("The downloaded file didn't match what the PC announced.")
                prefs.edit().putInt("target", m.optInt("versionCode")).apply()
                autoConfirmUntil = android.os.SystemClock.uptimeMillis() + 150_000
                install(file, name)
            } catch (e: Exception) {
                failed(e.message ?: "unknown")
            }
        }.start()
    }

    private fun install(file: File, name: String) {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setSize(file.length())
        if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        val id = installer.createSession(params)
        installer.openSession(id).use { session ->
            file.inputStream().use { input -> session.openWrite("bluey.apk", 0, file.length()).use { out -> input.copyTo(out); session.fsync(out) } }
            val intent = Intent(context, InstallResult::class.java).setAction(ACTION)
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
            session.commit(PendingIntent.getBroadcast(context, id, intent, flags).intentSender)
        }
        main.post { _status.value = "Installing Bluey $name…" }
        report("installing", name)
    }

    fun failed(message: String) {
        busy = false
        main.post { _status.value = "Couldn't update Bluey: $message" }
        report("failed", message)
    }

    companion object {
        const val ACTION = "app.bluey.INSTALL_RESULT"
        /** While an update we started is installing, BlueyHands may press Install / Update on Android's own dialog. */
        @Volatile var autoConfirmUntil = 0L
        fun confirming() = android.os.SystemClock.uptimeMillis() < autoConfirmUntil
    }
}

/** Android's answer to an install: confirm dialog needed, success or failure. */
class InstallResult : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val model = BlueyModel.get(context)
        when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION")
                val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                if (confirm != null) runCatching { context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            }
            PackageInstaller.STATUS_SUCCESS -> {}  // this process is replaced; the new one reports "installed"
            else -> model.updater.failed(intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "installer status $status")
        }
    }
}

/** After an update Android restarts nothing by itself: wake Bluey so the phone reconnects at once. */
class UpdatedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) { BlueyModel.get(context).start() }
}
