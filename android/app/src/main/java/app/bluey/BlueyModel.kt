package app.bluey

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import app.bluey.audio.Chirp
import app.bluey.audio.ListeningService
import app.bluey.audio.Mic
import app.bluey.audio.ReplyVoice
import app.bluey.face.FaceAnimator
import app.bluey.face.FaceState
import app.bluey.hands.BlueyHands
import app.bluey.link.LinkStatus
import app.bluey.link.PcLink
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONArray
import org.json.JSONObject

/** What Bluey is doing (decided by the PC; the phone shows it). */
enum class Mode { ASLEEP, WAKING, LISTENING, ASKING, THINKING, SPEAKING }

data class Entry(val kind: String, val text: String, val time: Long, val speaker: String? = null)
data class SessionSummary(val id: String, val started: Long, val ended: Long?, val live: Boolean, val summary: String, val questions: Int, val duration: Double)
data class SessionDetail(val id: String, val started: Long, val ended: Long?, val entries: List<Entry>, val notesPath: String?)

/**
 * The phone's half of Bluey: his face, your touch and the microphone. The PC runs the session (speech
 * recognition, the brain, notes); this sends what you do and shows what the PC says, so both always agree.
 */
class BlueyModel private constructor(private val context: Context) {
    private val prefs = context.getSharedPreferences("bluey", Context.MODE_PRIVATE)
    private val main = Handler(Looper.getMainLooper())
    val link = PcLink(context)
    val updater = Updater(context, link)
    val animator = FaceAnimator()
    val chirp = Chirp()
    val voice = ReplyVoice(context, { speaking, id ->
        link.send("voiceStatus", "playing" to speaking, "id" to id)
        animator.localMood = if (speaking) "talking" else if (_mode.value == Mode.THINKING) "thinking" else null
        BlueyHands.instance?.cursor?.setTalking(speaking)
    }, { showToast(it); link.send("voiceStatus", "playing" to false, "error" to it) })
    private val mic = Mic { bytes, n -> if ((micWanted || holding) && !voice.speaking) link.sendAudio(bytes, n) }

    private val _mode = MutableStateFlow(Mode.ASLEEP)
    val mode: StateFlow<Mode> = _mode
    private val _caption = MutableStateFlow("")
    val caption: StateFlow<String> = _caption
    private val _toast = MutableStateFlow<String?>(null)
    val toast: StateFlow<String?> = _toast
    private val _heard = MutableStateFlow("")
    val heard: StateFlow<String> = _heard
    private val _sessions = MutableStateFlow<List<SessionSummary>>(emptyList())
    val sessions: StateFlow<List<SessionSummary>> = _sessions
    private val _detail = MutableStateFlow<SessionDetail?>(null)
    val detail: StateFlow<SessionDetail?> = _detail
    private val _volume = MutableStateFlow(prefs.getFloat("volume", 1f))
    val volume: StateFlow<Float> = _volume
    private val _showReplies = MutableStateFlow(prefs.getBoolean("showReplies", true))
    val showReplies: StateFlow<Boolean> = _showReplies
    private val _needsMicPermission = MutableStateFlow(false)
    val needsMicPermission: StateFlow<Boolean> = _needsMicPermission
    private val _pcStatus = MutableStateFlow<JSONObject?>(null)
    val pcStatus: StateFlow<JSONObject?> = _pcStatus
    val learning = MutableStateFlow(JSONObject().put("enabled", true).put("items", JSONArray()))

    private var micWanted = false
    @Volatile var holding = false
        private set
    var hasMicPermission: () -> Boolean = { false }
    private val clearToast = Runnable { _toast.value = null }

    init {
        chirp.volume = _volume.value
        voice.volume = _volume.value
        voice.warm()
        animator.localTalk = { if (voice.speaking) 0.35 + 0.35 * kotlin.math.abs(kotlin.math.sin(now() * 13)) else chirp.level() }
        link.onMessage = { handle(it) }
        link.onConnected = {
            link.send("status")
            link.send("caps", "hands" to BlueyHands.enabled, "lite" to !app.bluey.BuildConfig.HANDS, "voice" to true, "version" to app.bluey.BuildConfig.VERSION_NAME, "versionCode" to app.bluey.BuildConfig.VERSION_CODE)
            updater.connected()
            refreshSessions()
        }
        link.onDisconnected = {
            // Without the PC there's no session: tidy up, but keep his face alive.
            setMode(Mode.ASLEEP)
            stopMic()
            _caption.value = ""
        }
        ListeningService.onEndRequested = { main.post { if (_mode.value != Mode.ASLEEP) link.send("sleep") } }
    }

    fun start() = link.start()
    fun stop() { voice.stop(); BlueyHands.instance?.cursor?.hideNow(); link.stop() }

    private fun now() = SystemClock.uptimeMillis() / 1000.0

    private fun handle(m: JSONObject) {
        when (m.optString("t")) {
            "face" -> animator.receive(FaceState(m.optDouble("gx", 0.0), m.optDouble("gy", 0.0), m.optString("mood", "listening"), m.optDouble("talk", 0.0)), now())
            "state" -> setMode(when (m.optString("state")) {
                "waking" -> Mode.WAKING; "listening" -> Mode.LISTENING; "asking" -> Mode.ASKING
                "thinking" -> Mode.THINKING; "speaking" -> Mode.SPEAKING; else -> Mode.ASLEEP
            })
            "mic" -> if (m.optBoolean("on")) { micWanted = true; startMic() } else { micWanted = false; if (!holding) stopMic() }
            "chirp" -> chirp.play(m.optInt("syllables", 3))
            "caption" -> {
                _caption.value = m.optString("text", "")
                BlueyHands.instance?.cursor?.caption(if (_showReplies.value) _caption.value else "")
            }
            "voice" -> if (m.optBoolean("stop")) voice.stop() else voice.play(m.optString("text"), m.optString("base64").takeIf { it.isNotEmpty() }, m.optString("id"))
            "heard" -> if (m.optBoolean("asked")) _heard.value = m.optString("text", "")
            "toast" -> showToast(m.optString("text"))
            "talkTest" -> animator.talkUntil = now() + m.optDouble("seconds", 3.0)
            "status" -> _pcStatus.value = m
            "learningChanged" -> refreshLearning()
            "update" -> updater.offered(m)
            "phoneCmd" -> phoneCommand(m)
            "sessionsChanged" -> { refreshSessions(); _detail.value?.let { if (it.started > 0) openSession(it.id) } }
            "entry" -> {
                val d = _detail.value
                if (d != null && d.id == m.optString("session")) {
                    val e = m.optJSONObject("entry")
                    if (e != null) _detail.value = d.copy(entries = d.entries + Entry(e.optString("kind"), e.optString("text"), e.optLong("time")))
                }
            }
        }
    }

    private fun setMode(mode: Mode) {
        _mode.value = mode
        BlueyHands.instance?.cursor?.setSession(mode.name.lowercase())
        if (mode == Mode.ASLEEP || mode == Mode.ASKING) voice.stop()
        animator.awake = mode != Mode.ASLEEP
        animator.localMood = when (mode) {
            Mode.ASLEEP -> null
            Mode.WAKING -> "happy"
            Mode.LISTENING -> null
            Mode.ASKING -> "listening"  // all ears while you hold
            Mode.THINKING -> "thinking"
            Mode.SPEAKING -> "talking"
        }
        if (mode == Mode.ASLEEP) { micWanted = false; if (!holding) stopMic(); _heard.value = "" }
    }

    // ───────────── Bluey using this phone (asked by the PC) ─────────────

    private val handsThread = java.util.concurrent.Executors.newSingleThreadExecutor()

    private fun phoneCommand(m: JSONObject) {
        val rid = m.optString("prid")
        val tool = m.optString("tool")
        val args = m.optJSONObject("args") ?: JSONObject()
        handsThread.execute {
            val hands = BlueyHands.instance
            val reply = JSONObject().put("t", "phoneResult").put("prid", rid)
            if (hands == null) {
                reply.put("text", if (app.bluey.BuildConfig.HANDS)
                    "Bluey isn't allowed to use the phone yet. On the phone: Bluey → grid button → \"Let Bluey use this phone\", then turn on Bluey in Accessibility."
                else "This is the Lite phone app, which can't control the phone. Install the Full phone app to let Bluey use the phone.")
            } else try {
                if (tool == "phone_look") {
                    val look = hands.look(m.optBoolean("image", true))
                    reply.put("text", look.optString("text"))
                    if (look.has("image")) reply.put("image", look.getString("image"))
                } else if (tool == "phone_apps") {
                    reply.put("text", "Apps on the phone: " + hands.installedApps().join(", ").replace("\"", ""))
                } else {
                    reply.put("text", hands.act(tool, args))
                    if (tool != "phone_bluey") {
                        hands.awaitUiStable(tool)
                        val look = hands.look(false)  // text only after an action: much quicker than a screenshot every step
                        reply.put("text", reply.optString("text") + "\nHere's the phone's screen now (ids have changed):\n" + look.optString("text"))
                    }
                }
            } catch (e: Exception) {
                reply.put("text", "That didn't work on the phone: ${e.message}")
            }
            main.post { link.send(reply) }
        }
    }

    // ───────────── What you do ─────────────

    /** Double tap: wake him up, or back to follow mode. */
    fun toggle() {
        if (!link.connected) { showToast("Not connected to your PC yet."); return }
        link.send("toggle")
    }

    /** Press and hold: what you say now is the question. The mic starts at once so no word is lost. */
    fun beginAsk() {
        if (!link.connected) { showToast("Connect to your PC to ask him things."); return }
        if (!hasMicPermission()) { _needsMicPermission.value = true; return }
        holding = true
        voice.stop()
        _caption.value = ""
        _heard.value = ""
        startMic()
        link.send("askStart")
    }

    /** Let go: he answers. */
    fun endAsk() {
        if (!holding) return
        holding = false
        // Keep sending a moment longer so the end of your sentence makes it.
        main.postDelayed({ link.send("askEnd"); if (!micWanted && !holding) main.postDelayed({ if (!micWanted && !holding) stopMic() }, 600) }, 150)
    }

    fun type(text: String) { if (text.isNotBlank()) link.send("type", "text" to text.trim()) }
    fun sayHi() { if (link.connected) link.send("sayHi") }
    fun stopActions() { link.send("stop") }
    fun refreshLearning() = learningRequest(JSONObject().put("t", "learning"))
    fun setLearning(on: Boolean) = learningRequest(JSONObject().put("t", "learning").put("action", "toggle").put("enabled", on))
    fun saveMemory(id: String?, kind: String, text: String) = learningRequest(JSONObject().put("t", "learning").put("action", "save")
        .put("item", JSONObject().put("id", id).put("kind", kind).put("text", text)))
    fun deleteMemory(id: String) = learningRequest(JSONObject().put("t", "learning").put("action", "delete").put("id", id))
    private fun learningRequest(request: JSONObject) {
        link.request(request) { reply -> if (reply != null) { learning.value = reply; if (reply.has("error")) showToast(reply.optString("error")) } }
    }

    fun micPermissionAnswered() { _needsMicPermission.value = false }

    private fun startMic() {
        if (!hasMicPermission()) { _needsMicPermission.value = true; return }
        if (!mic.isRunning) {
            ListeningService.start(context)
            if (!mic.start()) showToast("The microphone is busy or unavailable.")
        }
    }

    private fun stopMic() {
        if (mic.isRunning) mic.stop()
        ListeningService.stop(context)
    }

    val micLevel get() = mic.level

    // ───────────── Sessions (kept on the PC) ─────────────

    fun refreshSessions() {
        link.request(JSONObject().put("t", "sessions")) { reply ->
            val list = reply?.optJSONArray("list") ?: return@request
            _sessions.value = (0 until list.length()).map { i ->
                val s = list.getJSONObject(i)
                SessionSummary(s.optString("id"), s.optLong("started"), if (s.isNull("ended")) null else s.optLong("ended"),
                    s.optBoolean("live"), s.optString("summary"), s.optInt("questions"), s.optDouble("duration"))
            }
        }
    }

    fun openSession(id: String) {
        _detail.value = SessionDetail(id, 0, null, emptyList(), null)
        link.request(JSONObject().put("t", "session").put("id", id)) { reply ->
            val s = reply?.optJSONObject("session") ?: return@request
            _detail.value = SessionDetail(s.optString("id"), s.optLong("started"), if (s.isNull("ended")) null else s.optLong("ended"),
                entries(s.optJSONArray("entries")), if (s.isNull("notesPath")) null else s.optString("notesPath"))
        }
    }

    fun closeSession() { _detail.value = null }

    fun deleteSession(id: String) {
        link.request(JSONObject().put("t", "deleteSession").put("id", id)) { refreshSessions() }
        _detail.value = null
    }

    fun agentPrompt(id: String, done: (String?) -> Unit) {
        link.request(JSONObject().put("t", "agentPrompt").put("id", id)) { done(it?.optString("text")) }
    }

    private fun entries(array: JSONArray?): List<Entry> =
        if (array == null) emptyList() else (0 until array.length()).map { array.getJSONObject(it) }
            .map { Entry(it.optString("kind"), it.optString("text"), it.optLong("time"), if (it.isNull("speaker")) null else it.optString("speaker")) }

    // ───────────── Settings ─────────────

    fun setVolume(v: Float) {
        _volume.value = v
        chirp.volume = v
        voice.volume = v
        prefs.edit().putFloat("volume", v).apply()
    }

    fun setShowReplies(on: Boolean) {
        _showReplies.value = on
        BlueyHands.instance?.cursor?.caption(if (on) _caption.value else "")
        prefs.edit().putBoolean("showReplies", on).apply()
    }

    fun showToast(text: String) {
        if (text.isBlank()) return
        _toast.value = text
        main.removeCallbacks(clearToast)
        main.postDelayed(clearToast, 4500)
    }

    val linkStatus: StateFlow<LinkStatus> get() = link.status

    companion object {
        @Volatile private var instance: BlueyModel? = null
        fun get(context: Context): BlueyModel = instance ?: synchronized(this) {
            instance ?: BlueyModel(context.applicationContext).also { instance = it }
        }
    }
}
