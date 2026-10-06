package app.bluey.audio

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import app.bluey.MainActivity
import app.bluey.R

/**
 * Keeps the microphone allowed while a session runs, even if you switch apps or the screen turns off.
 * Shows an ongoing "Bluey is listening" notification with a button to end the session.
 */
class ListeningService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_END) {
            onEndRequested?.invoke()
            stop(this)
            return START_NOT_STICKY
        }
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(NotificationChannel(CHANNEL, "Listening", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Shown while Bluey's session is listening"
                setShowBadge(false)
            })
        }
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val end = PendingIntent.getService(this, 1, Intent(this, ListeningService::class.java).setAction(ACTION_END), PendingIntent.FLAG_IMMUTABLE)
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle("Bluey is listening")
            .setContentText("Hold his face to ask. Everything said goes in your notes.")
            .setContentIntent(open)
            .addAction(0, "End session", end)
            .setOngoing(true)
            .setSilent(true)
            .build()
        runCatching {
            ServiceCompat.startForeground(this, 7, notification,
                if (Build.VERSION.SDK_INT >= 30) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0)
        }
        return START_NOT_STICKY
    }

    companion object {
        private const val CHANNEL = "listening"
        private const val ACTION_END = "app.bluey.END"
        var onEndRequested: (() -> Unit)? = null

        fun start(context: Context) {
            runCatching { context.startForegroundService(Intent(context, ListeningService::class.java)) }
        }

        fun stop(context: Context) {
            runCatching { context.stopService(Intent(context, ListeningService::class.java)) }
        }
    }
}
