package app.bluey.audio

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.util.Log
import kotlin.math.sqrt

/**
 * The phone's microphone as 16 kHz mono PCM16, handed over in ~100 ms pieces. Runs on its own thread.
 * Echo cancellation keeps his own chirps out of the recording where the phone supports it.
 */
class Mic(private val onAudio: (ByteArray, Int) -> Unit) {
    @Volatile var level = 0.0
        private set
    @Volatile private var running = false
    private var thread: Thread? = null

    val isRunning get() = running

    @SuppressLint("MissingPermission")
    @Synchronized
    fun start(): Boolean {
        if (running) return true
        val rate = 16000
        val min = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val record = try {
            AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, rate, AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT, maxOf(min, 3200 * 4))
        } catch (e: Exception) { Log.w("Bluey", "mic", e); return false }
        if (record.state != AudioRecord.STATE_INITIALIZED) { record.release(); return false }
        runCatching { if (AcousticEchoCanceler.isAvailable()) AcousticEchoCanceler.create(record.audioSessionId)?.enabled = true }
        runCatching { if (NoiseSuppressor.isAvailable()) NoiseSuppressor.create(record.audioSessionId)?.enabled = true }
        try { record.startRecording() } catch (e: Exception) { record.release(); return false }
        running = true
        thread = Thread({
            val buffer = ByteArray(3200)  // 100 ms
            while (running) {
                var filled = 0
                while (filled < buffer.size && running) {
                    val n = record.read(buffer, filled, buffer.size - filled)
                    if (n <= 0) break
                    filled += n
                }
                if (filled <= 0) continue
                var sum = 0.0
                var i = 0
                while (i + 1 < filled) {
                    val s = ((buffer[i + 1].toInt() shl 8) or (buffer[i].toInt() and 0xFF)).toShort().toDouble()
                    sum += s * s
                    i += 2
                }
                level = sqrt(sum / (filled / 2).coerceAtLeast(1)) / 32768.0
                onAudio(buffer, filled)
            }
            runCatching { record.stop() }
            record.release()
            level = 0.0
        }, "bluey-mic").apply { priority = Thread.MAX_PRIORITY; start() }
        return true
    }

    @Synchronized
    fun stop() {
        running = false
        thread = null
    }
}
