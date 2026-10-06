package app.bluey.audio

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Base64
import java.io.File
import java.util.Locale

/** Plays the PC's neural voice, with the phone's speech engine as an offline fallback. */
class ReplyVoice(private val context: Context, private val changed: (Boolean, String?) -> Unit, private val error: (String) -> Unit) {
    private val main = Handler(Looper.getMainLooper())
    private val manager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
    private val focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
        .setAudioAttributes(attributes).setOnAudioFocusChangeListener { if (it < 0) stop() }.build()
    private var player: MediaPlayer? = null
    private var file: File? = null
    private var tts: TextToSpeech? = null
    private var ready = false
    private var pending: (() -> Unit)? = null
    private var generation = 0
    private var replyId: String? = null
    private val timeout = Runnable { stop(); error("His voice took too long. Please try again.") }
    @Volatile var speaking = false
        private set
    var volume = 1f
        set(value) { field = value.coerceIn(0f, 1f); player?.setVolume(field, field); if (field == 0f) stop() }

    private fun active(on: Boolean) {
        speaking = on
        changed(on, replyId)
        if (!on) { main.removeCallbacks(timeout); manager.abandonAudioFocusRequest(focus) }
    }

    fun play(text: String, base64: String?, id: String? = null) {
        stop()
        replyId = id
        if (text.isBlank() || volume == 0f) { stop(); return }
        val mine = generation
        if (manager.requestAudioFocus(focus) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
            stop(); error("Can't play his voice while another app has the audio."); return
        }
        main.postDelayed(timeout, 180_000)
        if (base64.isNullOrEmpty()) { nativeVoice(text, mine); return }
        try {
            val audio = File.createTempFile("bluey-reply-", ".mp3", context.cacheDir)
            file = audio
            audio.writeBytes(Base64.decode(base64, Base64.DEFAULT))
            val p = MediaPlayer()
            player = p
            p.setAudioAttributes(attributes)
            p.setVolume(volume, volume)
            p.setDataSource(audio.absolutePath)
            p.setOnPreparedListener { if (mine == generation) { it.start(); active(true) } }
            p.setOnCompletionListener { if (mine == generation) stop() }
            p.setOnErrorListener { _, _, _ ->
                if (mine == generation) { releasePlayer(); nativeVoice(text, mine) }; true
            }
            p.prepareAsync()
        } catch (_: Exception) { releasePlayer(); nativeVoice(text, mine) }
    }

    private fun nativeVoice(text: String, mine: Int) {
        if (mine != generation) return
        if (tts == null) {
            pending = { nativeVoice(text, mine) }
            warm()
            return
        }
        if (!ready) { pending = { nativeVoice(text, mine) }; return }
        val engine = tts ?: return
        val language = if (text.any { it in '\u0900'..'\u097f' }) Locale.forLanguageTag("hi-IN") else Locale.US
        if (engine.setLanguage(language) < 0) {
            stop(); error("Install the ${language.displayLanguage} voice in Android's text-to-speech settings."); return
        }
        engine.setSpeechRate(1.04f)
        engine.setAudioAttributes(attributes)
        val chunks = text.replace(Regex("[*_`#]"), "").chunked(TextToSpeech.getMaxSpeechInputLength() - 1)
        val lastId = "$mine:${chunks.lastIndex}"
        engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(id: String?) { main.post { if (mine == generation) active(true) } }
            override fun onDone(id: String?) { main.post { if (mine == generation && id == lastId) stop() } }
            @Deprecated("Android compatibility")
            override fun onError(id: String?) { main.post { if (mine == generation) { stop(); error("Android couldn't play his voice. Check your speech settings.") } } }
        })
        val params = Bundle().apply { putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, volume) }
        for ((i, chunk) in chunks.withIndex()) {
            if (engine.speak(chunk, if (i == 0) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD, params, "$mine:$i") == TextToSpeech.ERROR) {
                stop(); error("Android couldn't start his voice. Check your speech settings."); break
            }
        }
    }

    fun warm() {
        if (tts != null) return
        tts = TextToSpeech(context) { result -> main.post {
            ready = result == TextToSpeech.SUCCESS
            val next = pending; pending = null
            if (ready) next?.invoke()
            else { tts?.shutdown(); tts = null
                if (next != null) { stop(); error("Enable a text-to-speech engine in Android settings to hear Bluey.") }
            }
        } }
    }

    private fun releasePlayer() {
        player?.release(); player = null
        file?.delete(); file = null
    }

    fun stop() {
        generation++
        pending = null
        releasePlayer()
        tts?.stop()
        active(false)
        replyId = null
    }
}
