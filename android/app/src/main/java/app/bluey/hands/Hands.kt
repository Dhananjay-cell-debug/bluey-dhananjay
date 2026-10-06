package app.bluey.hands

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Base64
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.math.max
import kotlin.math.min

/**
 * Bluey's hands on the phone: an Accessibility service you switch on once (Settings → Accessibility → Bluey).
 * The PC asks for a look at the phone's screen (text and controls with ids, plus a screenshot) and for actions
 * (tap, type, scroll, back/home, open an app or link). He only acts when you ask, and never types into passwords.
 */
class BlueyHands : AccessibilityService() {
    /** His cursor on the phone's screen while he works. */
    val cursor: PhoneCursor by lazy { PhoneCursor(this) }

    override fun onServiceConnected() { instance = this }
    override fun onDestroy() { cursor.hideNow(); if (instance === this) instance = null; super.onDestroy() }
    override fun onUnbind(intent: Intent?): Boolean { cursor.hideNow(); if (instance === this) instance = null; return super.onUnbind(intent) }
    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}

    companion object {
        @Volatile var instance: BlueyHands? = null
        val enabled get() = instance != null

        fun openSettings(context: Context) {
            runCatching { context.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        }
    }

    // ───────────── Looking ─────────────

    private data class Target(val id: String, val node: AccessibilityNodeInfo, val bounds: Rect, val label: String, val kind: String)
    private var targets: Map<String, Target> = emptyMap()

    private fun screenSize(): Pair<Int, Int> {
        val dm = resources.displayMetrics
        return Pair(dm.widthPixels, dm.heightPixels)
    }

    private fun grid(r: Rect): String {
        val (w, h) = screenSize()
        return "@${(r.centerX() * 1000L / max(1, w))},${(r.centerY() * 1000L / max(1, h))}"
    }

    private fun appLabel(pkg: String?): String {
        if (pkg == null) return "?"
        return runCatching { packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString() }.getOrDefault(pkg)
    }

    /** Every visible piece of text and every control on the phone's screen, with ids for tapping. */
    fun look(withImage: Boolean): JSONObject {
        val list = ArrayList<Target>()
        var counter = 0
        val (w, h) = screenSize()
        val screen = Rect(0, 0, w, h)
        val roots = windows.mapNotNull { it.root }.ifEmpty { listOfNotNull(rootInActiveWindow) }
        fun walk(n: AccessibilityNodeInfo?, depth: Int) {
            if (n == null || depth > 40 || list.size >= 220) return
            if (!n.isVisibleToUser) return
            val r = Rect(); n.getBoundsInScreen(r)
            val text = (n.text?.toString() ?: "").trim()
            val desc = (n.contentDescription?.toString() ?: "").trim()
            val hint = if (Build.VERSION.SDK_INT >= 26) (n.hintText?.toString() ?: "").trim() else ""
            val label = listOf(text, desc, hint).firstOrNull { it.isNotEmpty() } ?: ""
            val kind = when {
                n.isEditable -> "text field"
                n.isCheckable -> if (n.isChecked) "switch (on)" else "switch (off)"
                n.isClickable -> "button"
                else -> "text"
            }
            if (Rect.intersects(r, screen) && r.width() > 2 && r.height() > 2 && (label.isNotEmpty() || n.isEditable || (n.isClickable && desc.isNotEmpty()))) {
                counter++
                list.add(Target("N$counter", n, r, if (n.isPassword) "password field" else label.take(80).replace('\n', ' '), kind))
            }
            for (i in 0 until n.childCount) walk(n.getChild(i), depth + 1)
        }
        roots.forEach { walk(it, 0) }
        targets = list.associateBy { it.id }
        val front = rootInActiveWindow?.packageName?.toString()
        val lines = ArrayList<String>()
        lines.add("Phone: ${Build.MANUFACTURER} ${Build.MODEL}, screen ${w}x$h. Front app: ${appLabel(front)} ($front)")
        lines.add("On the phone's screen (N ids, @x,y on a 0-1000 grid of the phone screen):")
        if (list.isEmpty()) lines.add("(nothing readable)")
        for (t in list) lines.add("${t.id} ${t.kind} ${grid(t.bounds)} \"${t.label}\"")
        val out = JSONObject().put("text", lines.joinToString("\n")).put("app", appLabel(front)).put("package", front ?: "")
        if (withImage) screenshot()?.let { out.put("image", it) }
        return out
    }

    /** A JPEG of the phone's screen (Android 11+), scaled to about 720 px. */
    private fun screenshot(): String? {
        if (Build.VERSION.SDK_INT < 30) return null
        val latch = CountDownLatch(1)
        var result: String? = null
        runCatching {
            takeScreenshot(Display.DEFAULT_DISPLAY, Executors.newSingleThreadExecutor(), object : TakeScreenshotCallback {
                override fun onSuccess(shot: ScreenshotResult) {
                    runCatching {
                        val hw = Bitmap.wrapHardwareBuffer(shot.hardwareBuffer, shot.colorSpace)
                        val bmp = hw?.copy(Bitmap.Config.ARGB_8888, false)
                        shot.hardwareBuffer.close()
                        if (bmp != null) {
                            val scale = min(1f, 720f / max(bmp.width, bmp.height))
                            val small = Bitmap.createScaledBitmap(bmp, (bmp.width * scale).toInt(), (bmp.height * scale).toInt(), true)
                            val bytes = ByteArrayOutputStream()
                            small.compress(Bitmap.CompressFormat.JPEG, 70, bytes)
                            result = Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP)
                        }
                    }
                    latch.countDown()
                }
                override fun onFailure(errorCode: Int) { latch.countDown() }
            })
        }.onFailure { latch.countDown() }
        latch.await(4, TimeUnit.SECONDS)
        return result
    }

    // ───────────── Acting ─────────────

    private fun point(args: JSONObject): Pair<Float, Float>? {
        val id = args.optString("target_id", "").uppercase()
        targets[id]?.let { return Pair(it.bounds.exactCenterX(), it.bounds.exactCenterY()) }
        if (args.has("x") && args.has("y")) {
            val (w, h) = screenSize()
            return Pair((args.optDouble("x").coerceIn(0.0, 1000.0) / 1000 * w).toFloat(), (args.optDouble("y").coerceIn(0.0, 1000.0) / 1000 * h).toFloat())
        }
        return null
    }

    private fun gesture(path: Path, durationMs: Long): Boolean {
        val latch = CountDownLatch(1)
        var ok = false
        val stroke = GestureDescription.StrokeDescription(path, 0, durationMs)
        val dispatched = dispatchGesture(GestureDescription.Builder().addStroke(stroke).build(), object : GestureResultCallback() {
            override fun onCompleted(g: GestureDescription?) { ok = true; latch.countDown() }
            override fun onCancelled(g: GestureDescription?) { latch.countDown() }
        }, Handler(Looper.getMainLooper()))
        if (!dispatched) return false
        latch.await(durationMs + 2000, TimeUnit.MILLISECONDS)
        return ok
    }

    private fun tapAt(x: Float, y: Float, long: Boolean = false): Boolean =
        gesture(Path().apply { moveTo(x, y) }, if (long) 700 else 60)

    /** Runs one action and says what happened. */
    fun act(name: String, args: JSONObject): String {
        when (name) {
            "phone_tap" -> {
                val id = args.optString("target_id", "").uppercase()
                val t = targets[id]
                val long = args.optBoolean("long", false)
                val p = point(args) ?: return "Tell me what to tap: an N id from phone_look, or x and y."
                cursor.fly(p.first, p.second)  // he flies there first, so you can see what he's about to touch
                cursor.click(p.first, p.second, long)
                if (t != null && !long && t.node.isClickable && t.node.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return "Tapped \"${t.label}\"."
                return if (tapAt(p.first, p.second, long)) (if (long) "Long-pressed" else "Tapped") + (t?.let { " \"${it.label}\"." } ?: " there.") else "The tap didn't go through."
            }
            "phone_type" -> {
                val text = args.optString("text", "")
                val id = args.optString("target_id", "").uppercase()
                val node = targets[id]?.node ?: findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
                    ?: return "Tap a text field first (or give its N id)."
                if (node.isPassword) return "That's a password field. Ask the user to type it themselves."
                node.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
                runCatching { val r = Rect(); node.getBoundsInScreen(r); cursor.fly(r.left + min(60, r.width() / 5).toFloat(), r.bottom.toFloat() - 6f); cursor.typed(text) }
                val existing = if (args.optBoolean("replace", true)) "" else (node.text?.toString() ?: "")
                val ok = node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT,
                    Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, existing + text) })
                if (!ok) return "That field didn't accept typing."
                if (args.optBoolean("press_enter", false)) {
                    if (Build.VERSION.SDK_INT >= 30) node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)
                }
                return "Typed it."
            }
            "phone_scroll" -> {
                val (w, h) = screenSize()
                val dir = args.optString("direction", "down")
                val cx = w / 2f; val cy = h / 2f
                val dy = h * 0.35f; val dx = w * 0.35f
                val path = Path()
                when (dir) {
                    "up" -> { path.moveTo(cx, cy - dy); path.lineTo(cx, cy + dy) }
                    "left" -> { path.moveTo(cx - dx, cy); path.lineTo(cx + dx, cy) }
                    "right" -> { path.moveTo(cx + dx, cy); path.lineTo(cx - dx, cy) }
                    else -> { path.moveTo(cx, cy + dy); path.lineTo(cx, cy - dy) }
                }
                when (dir) {
                    "up" -> cursor.swipe(cx, cy - dy, cx, cy + dy)
                    "left" -> cursor.swipe(cx - dx, cy, cx + dx, cy)
                    "right" -> cursor.swipe(cx + dx, cy, cx - dx, cy)
                    else -> cursor.swipe(cx, cy + dy, cx, cy - dy)
                }
                return if (gesture(path, 350)) "Scrolled $dir." else "Couldn't scroll."
            }
            "phone_key" -> {
                val action = when (args.optString("key")) {
                    "back" -> GLOBAL_ACTION_BACK
                    "home" -> GLOBAL_ACTION_HOME
                    "recents" -> GLOBAL_ACTION_RECENTS
                    "notifications" -> GLOBAL_ACTION_NOTIFICATIONS
                    "quick_settings" -> GLOBAL_ACTION_QUICK_SETTINGS
                    else -> return "Keys I can press: back, home, recents, notifications, quick_settings."
                }
                cursor.label(args.optString("key").replaceFirstChar { it.uppercase() })
                return if (performGlobalAction(action)) "Pressed ${args.optString("key")}." else "That didn't work."
            }
            "phone_open_app" -> { cursor.label("Opening " + args.optString("name")); return openApp(args.optString("name")) }
            "phone_open_url" -> {
                var url = args.optString("url").trim()
                if (url.isEmpty()) return "Which link?"
                if (!Regex("^[a-zA-Z][a-zA-Z0-9+.-]*:").containsMatchIn(url)) url = "https://$url"
                val uri = Uri.parse(url)
                cursor.label(uri.host ?: "Opening link")
                if (uri.scheme !in setOf("http", "https", "tel", "geo", "mailto", "whatsapp")) return "I only open web, phone, map, mail and WhatsApp links."
                return runCatching { startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); "Opened $url." }
                    .getOrDefault("Nothing on the phone can open that link.")
            }
            "phone_bluey" -> {
                val i = packageManager.getLaunchIntentForPackage(packageName)?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
                return if (i != null && runCatching { startActivity(i) }.isSuccess) "Back on his face." else "Couldn't bring Bluey back."
            }
        }
        return "Unknown phone action $name."
    }

    private fun openApp(name: String): String {
        val want = name.trim().lowercase()
        if (want.isEmpty()) return "Which app?"
        val pm = packageManager
        val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val apps = pm.queryIntentActivities(launcher, PackageManager.MATCH_ALL)
            .map { Pair(it.loadLabel(pm).toString(), it.activityInfo.packageName) }
        val best = apps.firstOrNull { it.first.lowercase() == want }
            ?: apps.filter { it.first.lowercase().startsWith(want) }.minByOrNull { it.first.length }
            ?: apps.filter { it.first.lowercase().contains(want) || it.second.lowercase().contains(want.replace(" ", "")) }.minByOrNull { it.first.length }
            ?: return "I couldn't find an app called \"$name\" on the phone."
        val intent = pm.getLaunchIntentForPackage(best.second)?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) ?: return "${best.first} can't be opened directly."
        return runCatching { startActivity(intent); "Opened ${best.first}." }.getOrDefault("Couldn't open ${best.first}.")
    }

    /** What the phone can do for the PC, as JSON lines for its tool reply. */
    fun installedApps(): JSONArray {
        val pm = packageManager
        val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        return JSONArray(pm.queryIntentActivities(launcher, PackageManager.MATCH_ALL).map { it.loadLabel(pm).toString() }.distinct().sorted())
    }
}
