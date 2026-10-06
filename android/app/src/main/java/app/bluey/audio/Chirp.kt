package app.bluey.audio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.SystemClock
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.random.Random

/**
 * His little cartoon chirp: a few soft, round, bell-like notes from a happy pentatonic scale, each with a little
 * upward "boop" at the start, like a small creature humming. He never talks out loud; this is his voice.
 */
class Chirp {
    private val rate = 24000
    @Volatile var volume = 1.0f
    @Volatile private var envelope: FloatArray? = null
    @Volatile private var startedAt = 0L

    /** Loudness right now (0…1), for his talking mouth. */
    fun level(): Double {
        val env = envelope ?: return 0.0
        val ms = SystemClock.uptimeMillis() - startedAt
        val i = (ms * rate / 1000L / 256L).toInt()
        return if (i in env.indices) env[i].toDouble() else 0.0
    }

    fun play(syllables: Int, random: Random = Random.Default) {
        if (volume <= 0.01f) return
        val samples = synth(syllables.coerceIn(1, 8), random)
        // A coarse loudness curve (one value per 256 samples) drives the mouth.
        val env = FloatArray(samples.size / 256 + 1)
        for (i in env.indices) {
            var peak = 0f
            for (j in i * 256 until min((i + 1) * 256, samples.size)) peak = maxOf(peak, abs(samples[j]))
            env[i] = min(1f, peak * 5f)
        }
        val pcm = ShortArray(samples.size) { (samples[it] * 32767).toInt().coerceIn(-32768, 32767).toShort() }
        Thread {
            runCatching {
                val track = AudioTrack.Builder()
                    .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                    .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(rate)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                    .setBufferSizeInBytes(pcm.size * 2)
                    .setTransferMode(AudioTrack.MODE_STATIC)
                    .build()
                track.write(pcm, 0, pcm.size)
                track.setVolume(volume)
                envelope = env
                startedAt = SystemClock.uptimeMillis()
                track.play()
                Thread.sleep(pcm.size * 1000L / rate + 80)
                track.release()
            }
        }.start()
    }

    fun synth(syllables: Int, random: Random): FloatArray {
        // C major pentatonic, two octaves up high (C6…E7), so it always sounds sweet together.
        val scale = doubleArrayOf(1046.5, 1174.7, 1318.5, 1568.0, 1760.0, 2093.0, 2349.3, 2637.0)
        var index = random.nextInt(1, 4)
        val out = ArrayList<Float>()
        for (i in 0 until syllables) {
            if (i > 0) index = (index + intArrayOf(-1, 1, 1, 2)[random.nextInt(4)]).coerceIn(0, scale.size - 1)
            val note = scale[index] * 0.5  // drop an octave: rounder, less piercing
            val last = i == syllables - 1
            val duration = if (last) 0.13 else 0.07 + random.nextDouble() * 0.02
            val count = (duration * rate).toInt()
            var phase = 0.0
            for (n in 0 until count) {
                val time = n.toDouble() / rate
                val t = n.toDouble() / count
                // Scoops up into the note over the first 25 ms, with a gentle wobble on the last one.
                val scoop = 1 - 0.18 * exp(-time / 0.012)
                val wobble = if (last) 1 + 0.012 * sin(time * 2 * PI * 18) else 1.0
                phase += 2 * PI * note * scoop * wobble / rate
                val attack = min(1.0, time / 0.006)
                val env = attack * exp(-t * 3.2) * (1 - t.pow(6))
                out.add(((sin(phase) + 0.12 * sin(2 * phase)) * env * 0.26).toFloat())
            }
            repeat((rate * 0.028).toInt()) { out.add(0f) }
        }
        return out.toFloatArray()
    }
}
