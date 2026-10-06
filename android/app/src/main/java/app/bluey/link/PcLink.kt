package app.bluey.link

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Base64
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.interfaces.ECPublicKey
import java.util.UUID
import java.util.concurrent.TimeUnit

/** A Bluey PC on this Wi-Fi (or over the USB cable). */
data class Pc(val name: String, val host: String, val port: Int) {
    val address get() = "$host:$port"
}

enum class LinkStatus { SEARCHING, CONNECTING, AWAITING_ALLOW, CONNECTED }

/**
 * Finds the Bluey PC (mDNS `_bluey._tcp` on the Wi-Fi, the last address that worked, one typed in, or the USB cable)
 * and keeps an encrypted WebSocket open to it (see [Secure]). The first time, both screens show the same six digits
 * and you click Allow on the PC. All callbacks arrive on the main thread.
 */
class PcLink(private val context: Context) {
    private val prefs = context.getSharedPreferences("link", Context.MODE_PRIVATE)
    private val main = Handler(Looper.getMainLooper())
    private val client = OkHttpClient.Builder()
        .pingInterval(8, TimeUnit.SECONDS)
        .connectTimeout(4, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    private val _status = MutableStateFlow(LinkStatus.SEARCHING)
    val status: StateFlow<LinkStatus> = _status
    private val _pcName = MutableStateFlow<String?>(null)
    val pcName: StateFlow<String?> = _pcName
    private val _found = MutableStateFlow<List<Pc>>(emptyList())
    val found: StateFlow<List<Pc>> = _found
    private val _pairError = MutableStateFlow<String?>(null)
    val pairError: StateFlow<String?> = _pairError
    private val _current = MutableStateFlow<Pc?>(null)
    val current: StateFlow<Pc?> = _current
    /** The six digits to compare with the PC while pairing. */
    private val _numbers = MutableStateFlow<String?>(null)
    val numbers: StateFlow<String?> = _numbers
    /** The PC's identity changed since we paired (reinstalled, or someone pretending): ask before trusting it. */
    private val _keyChanged = MutableStateFlow(false)
    val keyChanged: StateFlow<Boolean> = _keyChanged

    /** Every message from the PC (except replies to requests). */
    var onMessage: ((JSONObject) -> Unit)? = null
    var onConnected: (() -> Unit)? = null
    var onDisconnected: (() -> Unit)? = null

    private var socket: WebSocket? = null
    private var socketPc: Pc? = null
    private var channel: Secure.Channel? = null
    private var pendingPcPub: String? = null
    private var trustAwaited = false
    private var open = false
    private var started = false
    private var retryDelay = 1000L
    private val retry = Runnable { connectIfNeeded() }
    private var nextRid = 1
    private val waiting = HashMap<Int, (JSONObject?) -> Unit>()
    private var nsd: NsdManager? = null
    private var discovery: NsdManager.DiscoveryListener? = null
    private var multicastLock: WifiManager.MulticastLock? = null
    private val random = SecureRandom()
    private var usbTurn = false

    val deviceId: String = prefs.getString("deviceId", null) ?: UUID.randomUUID().toString().also { prefs.edit().putString("deviceId", it).apply() }
    private val deviceName: String = run {
        val name = runCatching { Settings.Global.getString(context.contentResolver, "device_name") }.getOrNull()
        if (!name.isNullOrBlank()) name else "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL}"
    }

    /** This phone's long-term key pair (made once, kept in the app's private storage). */
    private val identity: Pair<PrivateKey, ByteArray> = run {
        val priv = prefs.getString("idPriv", null)
        val pub = prefs.getString("idPub", null)
        if (priv != null && pub != null) {
            Pair(Secure.privateFromPkcs8(Base64.decode(priv, Base64.NO_WRAP)), Base64.decode(pub, Base64.NO_WRAP))
        } else {
            val kp = Secure.newKeyPair()
            val raw = Secure.encode(kp.public as ECPublicKey)
            prefs.edit().putString("idPriv", Base64.encodeToString(kp.private.encoded, Base64.NO_WRAP))
                .putString("idPub", Base64.encodeToString(raw, Base64.NO_WRAP)).apply()
            Pair(kp.private, raw)
        }
    }

    private fun lastPc(): Pc? {
        val host = prefs.getString("lastHost", null) ?: return null
        return Pc(prefs.getString("lastName", "PC") ?: "PC", host, prefs.getInt("lastPort", 47613))
    }
    val preferredName: String? get() = prefs.getString("preferred", null)

    fun start() {
        if (started) return
        started = true
        startDiscovery()
        connectIfNeeded()
    }

    fun stop() {
        started = false
        main.removeCallbacks(retry)
        stopDiscovery()
        socket?.close(1000, "bye")
        socket = null
        open = false
        _status.value = LinkStatus.SEARCHING
    }

    // ───────────── Discovery ─────────────

    private fun startDiscovery() {
        val manager = context.getSystemService(Context.NSD_SERVICE) as? NsdManager ?: return
        nsd = manager
        runCatching {
            val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            multicastLock = wifi.createMulticastLock("bluey").apply { setReferenceCounted(false); acquire() }
        }
        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {}
            override fun onDiscoveryStopped(serviceType: String) {}
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) { main.postDelayed({ if (started) { stopDiscovery(); startDiscovery() } }, 5000) }
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
            override fun onServiceFound(info: NsdServiceInfo) { resolve(manager, info) }
            override fun onServiceLost(info: NsdServiceInfo) {
                main.post { _found.value = _found.value.filterNot { it.name == info.serviceName } }
            }
        }
        discovery = listener
        runCatching { manager.discoverServices("_bluey._tcp", NsdManager.PROTOCOL_DNS_SD, listener) }
    }

    @Suppress("DEPRECATION")
    private fun resolve(manager: NsdManager, info: NsdServiceInfo) {
        runCatching {
            manager.resolveService(info, object : NsdManager.ResolveListener {
                override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                    if (errorCode == NsdManager.FAILURE_ALREADY_ACTIVE) main.postDelayed({ resolve(manager, info) }, 400)
                }
                override fun onServiceResolved(resolved: NsdServiceInfo) {
                    val host = resolved.host?.hostAddress ?: return
                    if (host.contains(':')) return  // keep to IPv4 on the LAN
                    val pc = Pc(resolved.serviceName, host, resolved.port)
                    main.post {
                        _found.value = (_found.value.filterNot { it.name == pc.name } + pc).sortedBy { it.name }
                        // Found on Wi-Fi while stuck trying an old address or USB: switch over.
                        if (!open && socketPc != null && socketPc?.host != pc.host) { socket?.cancel(); socket = null }
                        connectIfNeeded()
                    }
                }
            })
        }
    }

    private fun stopDiscovery() {
        discovery?.let { d -> runCatching { nsd?.stopServiceDiscovery(d) } }
        discovery = null
        runCatching { multicastLock?.release() }
    }

    // ───────────── Connection ─────────────

    /** Switches to another PC (from the list) and remembers the choice. */
    fun choose(pc: Pc) {
        prefs.edit().putString("preferred", pc.name).apply()
        if (socketPc != pc) { socket?.close(1000, "switch"); socket = null; open = false }
        connect(pc)
    }

    /** Connects to an address typed by hand, like 192.168.1.20 or 192.168.1.20:47613. */
    fun connectManually(text: String): Boolean {
        val t = text.trim().removePrefix("ws://").trimEnd('/')
        if (t.isEmpty()) return false
        val host = t.substringBefore(':')
        val port = t.substringAfter(':', "47613").toIntOrNull() ?: return false
        if (!Regex("^[A-Za-z0-9.-]+$").matches(host)) return false
        socket?.close(1000, "manual"); socket = null; open = false
        connect(Pc(host, host, port))
        return true
    }

    private fun connectIfNeeded() {
        if (!started || socket != null) return
        val list = _found.value
        val found = list.firstOrNull { it.name == preferredName } ?: list.firstOrNull { it.name == prefs.getString("lastName", null) }
            ?: list.firstOrNull()
        // Nothing found on Wi-Fi yet: alternate between the last address that worked and the USB cable.
        usbTurn = !usbTurn
        val last = lastPc()
        connect(found ?: if (usbTurn || last == null) USB else last)
    }

    private fun scheduleRetry() {
        main.removeCallbacks(retry)
        if (!started) return
        main.postDelayed(retry, retryDelay)
        retryDelay = (retryDelay * 1.6).toLong().coerceAtMost(8_000)
    }

    private fun connect(pc: Pc) {
        main.removeCallbacks(retry)
        if (_status.value != LinkStatus.AWAITING_ALLOW) _status.value = LinkStatus.CONNECTING
        _current.value = pc
        socketPc = pc
        channel = null
        val nonce = ByteArray(16).also { random.nextBytes(it) }
        val request = Request.Builder().url("ws://${pc.host}:${pc.port}/").build()
        socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                main.post {
                    if (webSocket !== socket) return@post
                    val hello = JSONObject().put("t", "hello").put("v", 2).put("name", deviceName).put("device", deviceId)
                        .put("pub", Base64.encodeToString(identity.second, Base64.NO_WRAP))
                        .put("nonce", Base64.encodeToString(nonce, Base64.NO_WRAP))
                    webSocket.send(hello.toString())
                }
            }

            // The PC's hello is the only plain-text frame; it sets up the encrypted channel.
            override fun onMessage(webSocket: WebSocket, text: String) {
                val m = runCatching { JSONObject(text) }.getOrNull() ?: return
                main.post { if (webSocket === socket) pcHello(webSocket, pc, m, nonce) }
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                val frame = channel?.open(bytes.toByteArray()) ?: return
                if (frame.first != Secure.KIND_TEXT) return
                val m = runCatching { JSONObject(String(frame.second, Charsets.UTF_8)) }.getOrNull() ?: return
                main.post { if (webSocket === socket) handle(pc, m) }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { main.post { dropped(webSocket) } }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { main.post { dropped(webSocket) } }
        })
    }

    private fun pcHello(ws: WebSocket, pc: Pc, m: JSONObject, nonce: ByteArray) {
        if (m.optString("t") != "hello") return
        val name = m.optString("name", pc.name)
        _pcName.value = name
        if (m.optBoolean("upgrade")) {
            _pairError.value = "Bluey on your PC and on this phone are different versions. Update both."
            ws.close(1000, "upgrade"); return
        }
        val pcPubB64 = m.optString("pub")
        val pcPub = runCatching { Base64.decode(pcPubB64, Base64.NO_WRAP) }.getOrNull() ?: return
        channel = runCatching {
            Secure.Channel(Secure.sessionKey(identity.first, pcPub, nonce, Base64.decode(m.optString("nonce"), Base64.NO_WRAP)))
        }.getOrNull()
        if (channel == null) { ws.close(1002, "bad key"); return }
        val known = prefs.getString("pcpub:$name", null)
        pendingPcPub = pcPubB64
        _pairError.value = null
        if (m.optBoolean("paired") && (known == null || known == pcPubB64)) {
            rememberPc(name, pcPubB64)
            becameReady(pc, name)
        } else {
            // Not paired yet (or this PC's identity changed): show the six digits; the PC shows the same and asks to Allow.
            _keyChanged.value = known != null && known != pcPubB64
            trustAwaited = m.optBoolean("paired") && _keyChanged.value
            _numbers.value = Secure.verificationNumbers(pcPub, identity.second)
            _status.value = LinkStatus.AWAITING_ALLOW
        }
    }

    /** The PC already knows this phone but its own key changed: you confirm on the phone with "Trust this PC". */
    fun trustPc() {
        val name = _pcName.value ?: return
        val pub = pendingPcPub ?: return
        rememberPc(name, pub)
        _keyChanged.value = false
        if (trustAwaited) { trustAwaited = false; _current.value?.let { becameReady(it, name) } }
    }

    private fun rememberPc(name: String, pub: String) { prefs.edit().putString("pcpub:$name", pub).apply() }

    private fun handle(pc: Pc, m: JSONObject) {
        when (m.optString("t")) {
            "paired" -> {
                val name = m.optString("name", pc.name)
                pendingPcPub?.let { rememberPc(name, it) }
                _keyChanged.value = false
                becameReady(pc, name)
            }
            "pairDenied" -> { _pairError.value = "Not allowed on the PC. Tap Try again, then click Allow there."; _numbers.value = null }
            else -> {
                val rid = m.optInt("rid", 0)
                val waiter = if (rid != 0) waiting.remove(rid) else null
                if (waiter != null) waiter(m) else onMessage?.invoke(m)
            }
        }
    }

    private fun becameReady(pc: Pc, name: String) {
        _numbers.value = null
        _pairError.value = null
        open = true
        retryDelay = 1000
        _status.value = LinkStatus.CONNECTED
        _pcName.value = name
        if (pc != USB) prefs.edit().putString("lastHost", pc.host).putInt("lastPort", pc.port).putString("lastName", name).apply()
        onConnected?.invoke()
    }

    private fun dropped(ws: WebSocket) {
        if (ws !== socket) return
        socket = null
        channel = null
        val wasOpen = open
        open = false
        val pending = waiting.values.toList()
        waiting.clear()
        pending.forEach { it(null) }
        if (wasOpen) onDisconnected?.invoke()
        if (_pairError.value == null && _status.value != LinkStatus.AWAITING_ALLOW) _status.value = LinkStatus.SEARCHING
        if (_pairError.value == null) scheduleRetry()
    }

    /** Tries pairing again (after "Don't allow"). */
    fun retryPairing() {
        _pairError.value = null
        _status.value = LinkStatus.CONNECTING
        socket?.close(1000, "retry"); socket = null; open = false
        connectIfNeeded()
    }

    /** Forgets this PC (to pair again from scratch). */
    fun forget() {
        _pcName.value?.let { name -> prefs.edit().remove("pcpub:$name").apply() }
        socket?.close(1000, "forget"); socket = null; open = false
        connectIfNeeded()
    }

    val connected get() = open

    @Synchronized  // seal + send together, so frames leave in counter order (mic thread vs main thread)
    private fun sendFrame(kind: Byte, bytes: ByteArray, length: Int = bytes.size): Boolean {
        val ch = channel ?: return false
        val ws = socket ?: return false
        return ws.send(ch.seal(kind, bytes, 0, length).toByteString())
    }

    fun send(json: JSONObject): Boolean = open && sendFrame(Secure.KIND_TEXT, json.toString().toByteArray(Charsets.UTF_8))

    fun send(type: String, vararg pairs: Pair<String, Any?>): Boolean {
        val json = JSONObject().put("t", type)
        for ((k, v) in pairs) json.put(k, v)
        return send(json)
    }

    fun sendAudio(bytes: ByteArray, length: Int): Boolean = open && sendFrame(Secure.KIND_AUDIO, bytes, length)

    /** Sends a request and calls back with the reply (null if the PC went away). */
    fun request(json: JSONObject, done: (JSONObject?) -> Unit) {
        if (!open) { done(null); return }
        val rid = nextRid++
        waiting[rid] = done
        json.put("rid", rid)
        if (!sendFrame(Secure.KIND_TEXT, json.toString().toByteArray(Charsets.UTF_8))) { waiting.remove(rid); done(null) }
        main.postDelayed({ waiting.remove(rid)?.invoke(null) }, 15_000)
    }

    companion object {
        /** Over a USB cable: the PC app runs `adb reverse tcp:47613 tcp:47613`, making the PC reachable at this address. */
        val USB = Pc("USB cable", "127.0.0.1", 47613)
    }
}
