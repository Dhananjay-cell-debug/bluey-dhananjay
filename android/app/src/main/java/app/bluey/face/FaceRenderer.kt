package app.bluey.face

import android.graphics.BlurMaskFilter
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.os.Build
import app.bluey.Palette
import kotlin.math.PI
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/** Draws his face: the landscape blueberry on pure black that fills the screen and peeks up from the bottom edge. */
class FaceRenderer(private val display: Typeface?) {
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
    private val blob = Path()
    private val tmp = Path()
    private val rect = RectF()

    companion object {
        const val DESIGN_W = 844f
        const val DESIGN_H = 390f
    }

    /** The blob outline: CSS `border-radius: 52% 48% 46% 54% / 58% 56% 44% 42%`. */
    fun blobPath(path: Path, x: Float, y: Float, w: Float, h: Float) {
        val tl = floatArrayOf(0.52f * w, 0.58f * h); val tr = floatArrayOf(0.48f * w, 0.56f * h)
        val br = floatArrayOf(0.46f * w, 0.44f * h); val bl = floatArrayOf(0.54f * w, 0.42f * h)
        val k = 0.5523f
        val maxX = x + w; val maxY = y + h
        path.reset()
        path.moveTo(x + tl[0], y)
        path.lineTo(maxX - tr[0], y)
        path.cubicTo(maxX - tr[0] * (1 - k), y, maxX, y + tr[1] * (1 - k), maxX, y + tr[1])
        path.lineTo(maxX, maxY - br[1])
        path.cubicTo(maxX, maxY - br[1] * (1 - k), maxX - br[0] * (1 - k), maxY, maxX - br[0], maxY)
        path.lineTo(x + bl[0], maxY)
        path.cubicTo(x + bl[0] * (1 - k), maxY, x, maxY - bl[1] * (1 - k), x, maxY - bl[1])
        path.lineTo(x, y + tl[1])
        path.cubicTo(x, y + tl[1] * (1 - k), x + tl[0] * (1 - k), y, x + tl[0], y)
        path.close()
    }

    fun gradient(x: Float, y: Float, w: Float, h: Float): Shader =
        LinearGradient(x + 0.25f * w, y + 0.067f * h, x + 0.75f * w, y + 0.933f * h, Palette.gradient, Palette.gradientStops, Shader.TileMode.CLAMP)

    private fun shine(bx: Float, by: Float): Shader =
        RadialGradient(bx + 246f, by + 126f, 243f, Color.argb(128, 255, 255, 255), Color.argb(0, 255, 255, 255), Shader.TileMode.CLAMP)

    /** Fills a shape with his skin (gradient plus the soft shine), for eyelids. */
    private fun fillSkin(c: Canvas, path: Path, bx: Float, by: Float, bw: Float, bh: Float) {
        fill.shader = gradient(bx, by, bw, bh); c.drawPath(path, fill)
        fill.shader = shine(bx, by); c.drawPath(path, fill)
        fill.shader = null
    }

    fun draw(c: Canvas, f: FaceFrame, width: Float, height: Float, background: Int = Color.BLACK) {
        c.drawColor(background)
        c.save()
        // Keep the crown, eyes and cheeks in view, with room around the face and controls.
        val scale = min(width / (DESIGN_W + 80f), height / (DESIGN_H + 36f))
        c.translate((width - DESIGN_W * scale) / 2, height - (DESIGN_H + 14f) * scale)
        c.scale(scale, scale)

        // Whole-body motion: breathing, talking bounce, idle hops, and leaning toward what he looks at.
        val bounce = (-f.talk * 16 + f.breathe * 3 - f.hop).toFloat()
        val bx = 12f; val by = 44f + bounce; val bw = 820f; val bh = 700f
        val px = bx + bw / 2; val py = by + bh
        c.translate(px, py)
        c.rotate(Math.toDegrees(f.lean).toFloat())
        val stretch = (1 + min(0.03, max(-0.03, f.hop / 900))).toFloat()
        c.scale(2 - stretch, stretch)
        c.translate(-px, -py)

        // Glow, body, shine and a glossy sparkle.
        blobPath(blob, bx, by, bw, bh)
        if (Build.VERSION.SDK_INT >= 28) {
            fill.color = Palette.withAlpha(Palette.BERRY2, 0.5f)
            fill.maskFilter = BlurMaskFilter(45f, BlurMaskFilter.Blur.NORMAL)
            c.save(); c.translate(0f, -10f); c.drawPath(blob, fill); c.restore()
            fill.maskFilter = null
        }
        fill.color = Palette.BERRY3
        fill.shader = gradient(bx, by, bw, bh)
        c.drawPath(blob, fill)
        c.save()
        c.clipPath(blob)
        fill.shader = shine(bx, by)
        c.drawRect(bx, by, bx + bw, by + bh, fill)
        fill.shader = null
        fill.color = Color.argb(89, 255, 255, 255)
        rect.set(bx + 190, by + 40, bx + 236, by + 62); c.drawOval(rect, fill)
        c.restore()

        // The little crown on his head.
        val crown = floatArrayOf(30f, 4f, 36f, 16f, 52f, 12f, 40f, 24f, 46f, 36f, 30f, 28f, 14f, 36f, 20f, 24f, 8f, 12f, 24f, 16f)
        val cx0 = bx + 368; val cy0 = by - 20 - (f.browLift * 0.3).toFloat()
        tmp.reset()
        for (i in crown.indices step 2) {
            val x = cx0 + crown[i] / 60f * 84f; val y = cy0 + crown[i + 1] / 40f * 56f
            if (i == 0) tmp.moveTo(x, y) else tmp.lineTo(x, y)
        }
        tmp.close()
        fill.color = Palette.NOSE
        c.drawPath(tmp, fill)

        val eyeY = by + 157
        val eyes = arrayOf(floatArrayOf(bx + 280, eyeY), floatArrayOf(bx + 540, eyeY))
        val squash = (1 - f.talk * 0.12).toFloat()

        // Blushy cheeks, rosier when he's happy.
        fill.color = Color.argb(((0.25 + 0.45 * f.blush) * 255).toInt().coerceIn(0, 255), 243, 166, 216)
        if (Build.VERSION.SDK_INT >= 28) fill.maskFilter = BlurMaskFilter(10f, BlurMaskFilter.Blur.NORMAL)
        for ((i, e) in eyes.withIndex()) {
            val side = if (i == 0) -1 else 1
            rect.set(e[0] - 45 + side * 62, e[1] + 96, e[0] + 45 + side * 62, e[1] + 138); c.drawOval(rect, fill)
        }
        fill.maskFilter = null

        for ((i, e) in eyes.withIndex()) {
            val ex = e[0]; val ey = e[1]
            val side = if (i == 0) -1f else 1f
            // Little arched eyebrows do a lot of the acting.
            c.save()
            val browY = ey - 112 - (min(18.0, max(-10.0, f.browLift)) * 0.7).toFloat()
            c.translate(ex + side * 6, browY)
            val tilt = f.browTilt * side * -1 + if (f.mood == "thinking" && i == 1) -0.25 else 0.0
            c.rotate(Math.toDegrees(tilt).toFloat())
            tmp.reset(); tmp.moveTo(-38f, 6f); tmp.quadTo(0f, -12f, 38f, 6f)
            stroke.color = Palette.NOSE; stroke.strokeWidth = 14f
            c.drawPath(tmp, stroke)
            c.restore()

            if (f.mood == "resting") {
                // Peacefully closed: a soft downward curve.
                tmp.reset(); tmp.moveTo(ex - 62, ey + 6); tmp.quadTo(ex, ey + 52, ex + 62, ey + 6)
                stroke.color = Palette.INK; stroke.strokeWidth = 18f
                c.drawPath(tmp, stroke)
                continue
            }
            if (f.mood == "happy" && f.squint > 0.6) {
                tmp.reset(); tmp.moveTo(ex - 60, ey + 34); tmp.quadTo(ex, ey - 54, ex + 60, ey + 34)
                stroke.color = Palette.INK; stroke.strokeWidth = 24f
                c.drawPath(tmp, stroke)
                continue
            }
            val open = (max(0.06, 1 - f.closed) * squash).toFloat()
            val wTop = ey - 95 * open; val wH = 190 * open
            rect.set(ex - 95, wTop, ex + 95, wTop + wH)
            fill.color = Color.WHITE
            c.drawOval(rect, fill)
            if (open <= 0.2f) continue
            c.save()
            tmp.reset(); tmp.addOval(rect, Path.Direction.CW)
            c.clipPath(tmp)
            val (gx, gy) = FaceAnimator.unitGaze(f.gazeX, f.gazeY)
            val reach = 50f
            val r = (46 * f.pupil).toFloat()
            val pX = ex + gx.toFloat() * reach - side * 3
            var pY = ey + gy.toFloat() * reach * open
            if (f.mood == "sleepy") pY = max(pY, ey) + 28  // eyes sink under heavy lids
            fill.color = Palette.INK
            c.drawCircle(pX, pY, r, fill)
            // Two catchlights make them shine.
            fill.color = Color.WHITE
            c.drawCircle(pX - r * 0.58f + r * 0.28f, pY - r * 0.72f + r * 0.28f, r * 0.28f, fill)
            fill.color = Color.argb(217, 255, 255, 255)
            c.drawCircle(pX + r * 0.28f + r * 0.12f, pY + r * 0.22f + r * 0.12f, r * 0.12f, fill)
            // Happy cheeks push up from below as he smiles.
            if (f.squint > 0.02) {
                val top = ey + 95 * open - 70 * f.squint.toFloat()
                rect.set(ex - 110, top, ex + 110, top + 160)
                tmp.reset(); tmp.addOval(rect, Path.Direction.CW)
                fillSkin(c, tmp, bx, by, bw, bh)
            }
            // Heavy, droopy lids when he's getting sleepy.
            if (f.mood == "sleepy") {
                val droop = (0.5 + 0.06 * sin(f.time * 1.3)).toFloat()
                tmp.reset(); tmp.addRect(ex - 100, wTop - 10, ex + 100, wTop + wH * droop, Path.Direction.CW)
                fillSkin(c, tmp, bx, by, bw, bh)
                stroke.color = Palette.withAlpha(Palette.NOSE, 0.7f); stroke.strokeWidth = 8f
                c.drawLine(ex - 92, wTop + wH * droop, ex + 92, wTop + wH * droop, stroke)
            }
            // A soft upper lid when he's focused on pointing.
            if (f.mood == "pointing") {
                tmp.reset(); tmp.addRect(ex - 100, wTop - 20, ex + 100, wTop + 20, Path.Direction.CW)
                fillSkin(c, tmp, bx, by, bw, bh)
            }
            c.restore()
        }

        fill.typeface = display
        fill.fontVariationSettings = "'wght' 700"
        fill.textAlign = Paint.Align.CENTER
        if (f.mood == "resting") {
            // Little z's floating up while he naps.
            for (i in 0 until 3) {
                val phase = ((f.time * 0.35 + i / 3.0) % 1.0)
                fill.textSize = 26f + i * 8f
                fill.color = Color.argb((0.9 * sin(PI * phase) * 255).toInt().coerceIn(0, 255), 255, 255, 255)
                c.drawText("z", bx + 660 + phase.toFloat() * 70 + sin(phase * 6).toFloat() * 8, by + 90 - phase.toFloat() * 110 + 9, fill)
            }
        }
        if (f.mood == "thinking") {
            for (i in 0 until 3) {
                val wobble = (sin(f.time * 3 + i) * 4).toFloat()
                fill.color = Color.argb(((1 - i * 0.3) * 255).toInt(), 255, 255, 255)
                c.drawCircle(bx + 698 + i * 26, by + 48 - i * 12 + wobble, 8f, fill)
            }
        }

        // His little mouth-nose: opens as he talks, curls into a smile when he's happy.
        val noseW = (60 - f.talk * 8).toFloat(); val noseH = (38 + f.talk * 34).toFloat()
        val nx = bx + 410 - noseW / 2; val ny = by + 272 - (f.talk * 6).toFloat()
        fill.color = Palette.NOSE
        if (f.mood == "happy" && f.talk < 0.1) {
            tmp.reset(); tmp.moveTo(nx - 8, ny + 8); tmp.quadTo(nx + noseW / 2, ny + 58, nx + noseW + 8, ny + 8); tmp.close()
            c.drawPath(tmp, fill)
        } else {
            rect.set(nx, ny, nx + noseW, ny + noseH); c.drawOval(rect, fill)
            if (f.talk > 0.25) {
                fill.color = Color.argb(230, 229, 139, 196)
                val tw = noseW * 0.56f; val th = noseH * 0.3f
                val tx = nx + noseW / 2 - tw / 2; val ty = ny + noseH - noseH * 0.38f
                rect.set(tx, ty, tx + tw, ty + th); c.drawOval(rect, fill)
            }
        }
        c.restore()
    }

    /** A tiny Bluey: the blob with two googly eyes. */
    fun mini(c: Canvas, x: Float, y: Float, w: Float, h: Float) {
        blobPath(tmp, x, y, w, h)
        fill.shader = gradient(x, y, w, h); c.drawPath(tmp, fill); fill.shader = null
        val r = w * 0.13f; val cy = y + h / 2 - w * 0.04f
        for (cx in floatArrayOf(x + w / 2 - w * 0.18f, x + w / 2 + w * 0.18f)) {
            fill.color = Color.WHITE; c.drawCircle(cx, cy, r, fill)
            fill.color = Palette.INK; c.drawCircle(cx + r * 0.07f, cy + r * 0.11f, w * 0.06f, fill)
        }
    }
}
