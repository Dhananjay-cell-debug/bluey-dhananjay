package app.bluey.hands

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.RectF
import android.graphics.Shader
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.view.animation.PathInterpolator
import app.bluey.Palette
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.random.Random

/**
 * Bluey's own cursor on the phone's screen, drawn over every app while he works for you: it flies to what he's about
 * to tap, squishes and bursts stars on a tap, floats the letters he types, shows what he's opening, and fades away
 * when he's done. Shown through the Accessibility service's overlay window; touches pass straight through it.
 */
class PhoneCursor(private val service: AccessibilityService) {
    private val main = Handler(Looper.getMainLooper())
    private val wm = service.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    private var view: CursorView? = null
    private val fadeOut = Runnable { view?.fade(false); main.postDelayed({ remove() }, 500) }

    private fun ensure(): CursorView {
        view?.let { return it }
        val v = CursorView(service)
        val lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        ).apply { gravity = Gravity.TOP or Gravity.START }
        runCatching { wm.addView(v, lp); view = v }
        return v
    }

    private fun remove() {
        view?.let { runCatching { wm.removeView(it) } }
        view = null
    }

    private fun touch() {
        main.removeCallbacks(fadeOut)
        main.postDelayed(fadeOut, 3500)
    }

    /** Flies the cursor to a point and waits until it lands (so the tap that follows happens where you're looking). */
    fun fly(x: Float, y: Float, ms: Long = 460) {
        val latch = CountDownLatch(1)
        main.post {
            runCatching {
                val v = ensure()
                v.fade(true)
                v.flyTo(x, y, ms) { latch.countDown() }
                touch()
            }.onFailure { latch.countDown() }
        }
        runCatching { latch.await(ms + 900, TimeUnit.MILLISECONDS) }
    }

    fun click(x: Float, y: Float, long: Boolean = false) { main.post { runCatching { ensure().click(x, y, long); touch() } } }
    fun typed(text: String) { main.post { runCatching { ensure().typed(text); touch() } } }
    fun label(text: String) { main.post { runCatching { ensure().showLabel(text); touch() } } }

    /** A swipe: the cursor goes to the start, then drags to the end. */
    fun swipe(x1: Float, y1: Float, x2: Float, y2: Float, ms: Long = 380) {
        fly(x1, y1, 380)
        main.post { runCatching { ensure().press() } }
        fly(x2, y2, ms)
    }

    fun hideNow() { main.removeCallbacks(fadeOut); main.post { remove() } }
}

private class CursorView(context: Context) : View(context) {
    private val dp = resources.displayMetrics.density
    private val size = 52f * dp
    private var tx = -1000f
    private var ty = -1000f
    private var sx = 0f; private var sy = 0f; private var ex = 0f; private var ey = 0f
    private var t0 = 0L; private var dur = 1L
    private var flying = false
    private var onArrive: (() -> Unit)? = null
    private var vx = 0f; private var vy = 0f
    private var pressStart = -10_000L
    private var pressDepth = 0f
    private var opacity = 0f
    private var wantOpacity = 0f
    private var label: String? = null
    private var labelBorn = 0L
    private val ease = PathInterpolator(0.42f, 0f, 0.22f, 1f)
    private val effects = ArrayList<Fx>()

    private class Fx(val kind: Int, val x: Float, val y: Float, val born: Long, val life: Long, val dx: Float, val dy: Float, val ch: String?, val color: Int, val spin: Float)

    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply { textAlign = Paint.Align.CENTER; isFakeBoldText = true }
    private val body = Path()
    private val tmp = RectF()
    private val rnd = Random(7)

    fun fade(on: Boolean) { wantOpacity = if (on) 1f else 0f; invalidate() }

    fun flyTo(x: Float, y: Float, ms: Long, done: () -> Unit) {
        if (tx < -500f) { tx = x - 120f * dp; ty = y + 160f * dp }  // first time: come in from below-left
        sx = tx; sy = ty; ex = x; ey = y
        t0 = SystemClock.uptimeMillis(); dur = max(ms, 1)
        flying = true; onArrive = done
        invalidate()
    }

    fun press() { pressStart = SystemClock.uptimeMillis(); pressDepth = 0.1f; invalidate() }

    fun click(x: Float, y: Float, long: Boolean) {
        val now = SystemClock.uptimeMillis()
        pressStart = now; pressDepth = if (long) 0.16f else 0.14f
        effects.add(Fx(0, x, y, now, 650, 0f, 0f, null, Palette.BERRY2, 0f))
        for (i in 0 until 6) {
            val a = i / 6f * 2f * PI.toFloat() + rnd.nextFloat() * 0.5f - 0.25f
            val d = (34f + rnd.nextFloat() * 24f) * dp
            effects.add(Fx(1, x, y, now, 560, cos(a) * d, sin(a) * d, null, intArrayOf(Palette.BERRY1, Palette.BERRY2, Palette.BERRY3)[rnd.nextInt(3)], rnd.nextFloat() * 5f - 2.5f))
        }
        invalidate()
    }

    fun typed(s: String) {
        val now = SystemClock.uptimeMillis()
        pressStart = now; pressDepth = 0.035f
        s.take(24).forEachIndexed { i, ch ->
            if (!ch.isWhitespace()) effects.add(Fx(2, tx + size * 0.55f + i * 7f * dp, ty - 6f * dp, now + i * 40L, 900, rnd.nextFloat() * 28f * dp - 12f * dp, -46f * dp, ch.toString(), Palette.BERRY3, 0f))
        }
        invalidate()
    }

    fun showLabel(s: String) { label = s; labelBorn = SystemClock.uptimeMillis(); invalidate() }

    private fun teardrop(s: Float) {
        val tip = 6f / 96f * s
        body.reset()
        tmp.set(0f, 0f, s, s)
        body.addRoundRect(tmp, floatArrayOf(tip, tip, s / 2, s / 2, s / 2, s / 2, s / 2, s / 2), Path.Direction.CW)
    }

    override fun onDraw(c: Canvas) {
        val now = SystemClock.uptimeMillis()
        // Position along a gently bowed curve, with the same easing as the laptop cursor.
        if (flying) {
            val p = min(1f, (now - t0).toFloat() / dur)
            val e = ease.getInterpolation(p)
            val dx = ex - sx; val dy = ey - sy
            val dist = hypot(dx, dy).coerceAtLeast(1f)
            val bow = min(dist * 0.1f, 70f * dp) * 0.75f
            val nx = -dy / dist; val ny = dx / dist
            val mx = (sx + ex) / 2 + nx * bow * (if (ny > 0) -1 else 1); val my = (sy + ey) / 2 + ny * bow * (if (ny > 0) -1 else 1)
            val u = 1 - e
            val px = u * u * sx + 2 * u * e * mx + e * e * ex
            val py = u * u * sy + 2 * u * e * my + e * e * ey
            vx = px - tx; vy = py - ty
            tx = px; ty = py
            if (p >= 1f) { flying = false; vx = 0f; vy = 0f; val cb = onArrive; onArrive = null; cb?.invoke(); effects.add(Fx(0, tx, ty, now, 700, 0f, 0f, null, Palette.BERRY2, 0f)) }
        }
        opacity += (wantOpacity - opacity) * 0.22f

        // Soft ring and stars.
        val it = effects.iterator()
        while (it.hasNext()) {
            val f = it.next()
            val t = (now - f.born).toFloat() / f.life
            if (t >= 1f) { it.remove(); continue }
            if (t < 0f) continue
            val a = (1 - t)
            when (f.kind) {
                0 -> { stroke.color = Palette.withAlpha(f.color, 0.8f * a * opacity); stroke.strokeWidth = 3.5f * dp
                    c.drawCircle(f.x, f.y, (38f * dp) * (0.3f + 0.7f * (1 - (1 - t) * (1 - t))), stroke) }
                1 -> { val e = 1 - (1 - t) * (1 - t); fill.color = Palette.withAlpha(f.color, a.coerceIn(0f, 1f))
                    c.save(); c.translate(f.x + f.dx * e, f.y + f.dy * e); c.rotate(f.spin * t * 57f); c.scale(1 - 0.6f * t, 1 - 0.6f * t); drawStar(c, 6f * dp); c.restore() }
                2 -> { val e = 1 - (1 - t) * (1 - t); text.textSize = 22f * dp * (1.1f - 0.35f * t)
                    val alpha = if (t < 0.12f) t / 0.12f else if (t < 0.55f) 1f else 1f - (t - 0.55f) / 0.45f
                    c.save(); c.translate(f.x + f.dx * e, f.y + f.dy * e)
                    text.style = Paint.Style.STROKE; text.strokeWidth = 5f * dp; text.color = Palette.withAlpha(Color.WHITE, alpha); c.drawText(f.ch ?: "", 0f, 0f, text)
                    text.style = Paint.Style.FILL; text.color = Palette.withAlpha(Palette.BERRY3, alpha); c.drawText(f.ch ?: "", 0f, 0f, text); c.restore() }
            }
        }

        if (opacity > 0.02f) drawCursor(c, now)
        drawLabel(c, now)
        if (flying || effects.isNotEmpty() || opacity > 0.02f || label != null) postInvalidateOnAnimation()
    }

    private fun drawStar(c: Canvas, r: Float) {
        body.reset()
        for (i in 0 until 8) {
            val rr = if (i % 2 == 0) r else r * 0.4f
            val a = i * PI.toFloat() / 4 - PI.toFloat() / 2
            val px = cos(a) * rr; val py = sin(a) * rr
            if (i == 0) body.moveTo(px, py) else body.lineTo(px, py)
        }
        body.close()
        c.drawPath(body, fill)
    }

    private fun drawCursor(c: Canvas, now: Long) {
        val s = size
        val t = (now - pressStart) / 1000f
        val squish = if (t in 0f..0.42f) {
            if (t < 0.12f) 1f - pressDepth * sin(t / 0.12f * PI.toFloat() / 2) else { val r = (t - 0.12f) / 0.3f; 1f - pressDepth * cos(r * PI.toFloat() * 1.5f) * exp(-r * 3.2f) }
        } else 1f
        c.save()
        c.translate(tx, ty)
        c.rotate(0f)
        c.scale(squish, squish)
        teardrop(s)
        // A soft shadow, then the blueberry gradient, a shine and the white rim.
        fill.shader = null; fill.color = Palette.withAlpha(Palette.BERRY4, 0.28f * opacity)
        c.save(); c.translate(0f, 4f * dp); c.drawPath(body, fill); c.restore()
        fill.shader = LinearGradient(0.25f * s, 0.067f * s, 0.75f * s, 0.933f * s, Palette.gradient, Palette.gradientStops, Shader.TileMode.CLAMP)
        fill.alpha = (255 * opacity).toInt()
        c.drawPath(body, fill)
        fill.shader = null
        fill.color = Palette.withAlpha(Color.WHITE, 0.35f * opacity); tmp.set(0.14f * s, 0.12f * s, 0.46f * s, 0.34f * s); c.drawOval(tmp, fill)
        stroke.color = Palette.withAlpha(Color.WHITE, opacity); stroke.strokeWidth = 3.2f * dp; c.drawPath(body, stroke)
        // Eyes look where he's heading.
        val k = s / 96f
        val speed = hypot(vx, vy)
        val ang = if (speed > 1.5f) atan2(vy, vx) else (-3f * PI.toFloat() / 4f)
        val lx = if (speed > 1.5f) cos(ang) else -0.7f
        val ly = if (speed > 1.5f) sin(ang) else -0.7f
        val blink = ((now / 3300L) % 2L == 0L) && (now % 3300L) < 120L
        for (i in 0 until 2) {
            val d = 18f * k
            val cx = (34f + i * 24f) * k + d / 2; val cy = 40f * k + d / 2
            c.save(); c.translate(cx, cy); c.scale(1f, if (blink) 0.12f else 1f)
            fill.color = Palette.withAlpha(Color.WHITE, opacity); c.drawCircle(0f, 0f, d / 2, fill)
            fill.color = Palette.withAlpha(Palette.INK, opacity); c.drawCircle(lx * 3.4f * k, ly * 3.4f * k, 4.5f * k, fill)
            c.restore()
        }
        c.restore()
    }

    private fun drawLabel(c: Canvas, now: Long) {
        val l = label ?: return
        val age = (now - labelBorn) / 1000f
        if (age > 1.8f) { label = null; return }
        text.style = Paint.Style.FILL; text.textSize = 17f * dp
        val w = text.measureText(l) + 28f * dp; val h = 36f * dp
        var x = tx + size * 1.05f; val y = max(ty - size * 0.1f, h) - min(age, 0.3f) * 20f
        if (x + w > width - 12f * dp) x = tx - w - size * 0.3f
        val a = min(1f, min(age / 0.12f, (1.8f - age) / 0.3f)).coerceIn(0f, 1f)
        tmp.set(x, y - h / 2, x + w, y + h / 2)
        fill.shader = null; fill.color = Palette.withAlpha(Palette.INK, 0.92f * a); c.drawRoundRect(tmp, 14f * dp, 14f * dp, fill)
        stroke.color = Palette.withAlpha(Palette.BERRY2, 0.9f * a); stroke.strokeWidth = 2f * dp; c.drawRoundRect(tmp, 14f * dp, 14f * dp, stroke)
        text.color = Palette.withAlpha(Color.WHITE, a); c.drawText(l, x + w / 2, y + text.textSize / 3, text)
    }
}
