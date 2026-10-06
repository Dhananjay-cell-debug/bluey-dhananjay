package app.bluey.face

import kotlin.math.PI
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.random.Random

/** What the PC asks the face to do. Gaze x: -1 left … 1 right, y: -1 up … 1 down. */
data class FaceState(val gx: Double = 0.0, val gy: Double = 0.0, val mood: String = "listening", val talk: Double = 0.0)

/** A tiny damped spring, so every part of the face moves with a little life. */
private class Spring(var value: Double, val stiffness: Double = 200.0, val damping: Double = 0.7) {
    var velocity = 0.0
    fun step(target: Double, dt: Double) {
        val c = 2 * sqrt(stiffness) * damping
        velocity += (stiffness * (target - value) - c * velocity) * dt
        value += velocity * dt
    }
}

/** One frame of the face, ready to draw. */
data class FaceFrame(
    val gazeX: Double, val gazeY: Double, val mood: String, val talk: Double,
    val closed: Double, val breathe: Double, val time: Double, val pupil: Double,
    val browLift: Double, val browTilt: Double, val lean: Double, val hop: Double,
    val blush: Double, val squint: Double,
)

/** Smooths what the PC asks for into lifelike motion: darting eyes, brows, blinks, leaning, hops. */
class FaceAnimator(private val random: Random = Random.Default) {
    private var target = FaceState()
    private var lastPacket = -100.0
    private val gazeX = Spring(0.0, 260.0, 0.82)
    private val gazeY = Spring(0.0, 260.0, 0.82)
    private val pupil = Spring(1.0, 160.0, 0.5)
    private val browLift = Spring(0.0, 180.0, 0.55)
    private val browTilt = Spring(0.0, 150.0, 0.6)
    private val lean = Spring(0.0, 60.0, 0.8)
    private val hop = Spring(0.0, 260.0, 0.35)
    private val blush = Spring(0.25, 40.0, 1.0)
    private val squint = Spring(0.0, 150.0, 0.7)
    private var talk = 0.0
    private var mood = "listening"
    private var blinkStart = -1.0
    private var doubleBlink = false
    private var nextBlink = 2.0
    private var lastTime: Double? = null
    private var nextSaccade = 0.0
    private var wanderX = 0.0
    private var wanderY = -0.3
    private var jitterX = 0.0
    private var jitterY = 0.0
    private var nextJitter = 0.0
    private var nextHop = 6.0

    /** Mood set on the phone itself (waking up, all ears, thinking, replying). */
    @Volatile var localMood: String? = null
    /** Loudness of the chirp playing on this phone, 0…1. */
    @Volatile var localTalk: () -> Double = { 0.0 }
    /** True while he's awake and talking with you. In follow mode his eyes stay locked on your mouse. */
    @Volatile var awake = false
    /** Set while a finger is on the screen (-1…1 gaze units): his eyes follow it. */
    @Volatile var touchGaze: Pair<Double, Double>? = null
    /** Talk test from the PC: bounce for a few seconds. */
    @Volatile var talkUntil = 0.0

    private fun rand(a: Double, b: Double) = a + random.nextDouble() * (b - a)

    @Synchronized
    fun receive(face: FaceState, time: Double) {
        target = face
        lastPacket = time
    }

    @Synchronized
    fun step(now: Double): FaceFrame {
        val dt = min(now - (lastTime ?: now), 1.0 / 20)
        lastTime = now
        val live = now - lastPacket < 2.5
        val wanted = localMood ?: if (live) target.mood else "listening"
        if (wanted != mood) {
            mood = wanted
            blinkStart = now  // blink through every mood change
            if (wanted != "sleepy" && wanted != "resting") {
                hop.velocity += 260.0  // and a little bounce of surprise
                pupil.velocity += 3.0
            }
        }

        // Where to look, plus tiny darting movements so the eyes never sit dead still.
        var wantX: Double
        var wantY: Double
        val touch = touchGaze
        if (touch != null) {
            wantX = touch.first; wantY = touch.second
        } else if (live) {
            wantX = target.gx; wantY = target.gy
        } else {
            if (now > nextSaccade) {
                wanderX = rand(-0.9, 0.9); wanderY = rand(-0.9, 0.4)
                nextSaccade = now + rand(0.6, 2.2)
            }
            wantX = wanderX; wantY = wanderY
        }
        if (mood == "thinking") { wantX = 0.6 + 0.08 * sin(now * 1.3); wantY = -0.85 }
        if (now > nextJitter) {
            // While he's listening his eyes stay on your mouse; the livelier darting is for replying.
            val a = if (!awake) 0.015 else when (mood) { "talking" -> 0.07; "thinking" -> 0.05; else -> 0.02 }
            jitterX = rand(-a, a); jitterY = rand(-a, a)
            nextJitter = now + rand(0.5, 1.4)
        }
        gazeX.step(wantX + jitterX, dt)
        gazeY.step(wantY + jitterY, dt)

        val testing = now < talkUntil
        var wantTalk = when {
            testing || (!live && localMood == "talking") -> 0.5 + 0.5 * sin(now * 19) * sin(now * 7.3)
            live -> target.talk
            else -> 0.0
        }
        wantTalk = max(wantTalk, localTalk())
        talk += (wantTalk - talk) * min(1.0, dt * 25)

        var wPupil = 1.0; var wLift = 0.0; var wTilt = 0.0; var wBlush = 0.25; var wSquint = 0.0
        when (mood) {
            "listening" -> { wPupil = 1.12; wLift = 10.0 }
            "talking" -> { wPupil = 1.05; wLift = 6 + talk * 18; wTilt = 0.05 * sin(now * 2.3) }
            "pointing" -> { wPupil = 0.95; wLift = -4.0; wTilt = -0.14 }
            "thinking" -> { wPupil = 0.9; wLift = 4.0; wTilt = 0.22 }
            "happy" -> { wPupil = 1.2; wLift = 16.0; wBlush = 0.85; wSquint = 1.0 }
            "resting" -> { wPupil = 0.9; wLift = -8.0; wBlush = 0.15 }
            "sleepy" -> { wPupil = 0.88; wLift = -10.0; wTilt = 0.12; wBlush = 0.15 }
        }
        pupil.step(wPupil, dt); browLift.step(wLift, dt); browTilt.step(wTilt, dt)
        blush.step(wBlush, dt); squint.step(wSquint, dt); lean.step(-gazeX.value * 0.045, dt)

        // An occasional happy little hop when nothing much is going on.
        if (now > nextHop) {
            if (talk < 0.05 && mood != "sleepy" && mood != "resting") hop.velocity += rand(180.0, 320.0)
            nextHop = now + rand(7.0, 14.0)
        }
        hop.step(0.0, dt)

        // Blinks, sometimes doubled. When he's drowsy they're slow and heavy.
        val drowsy = mood == "sleepy"
        if (now > nextBlink) {
            blinkStart = now
            doubleBlink = !drowsy && random.nextDouble() < 0.25
            nextBlink = now + if (drowsy) rand(1.6, 3.0) else rand(2.0, 5.0)
        }
        val p = (now - blinkStart) / if (drowsy) 0.7 else 0.15
        var closed = if (p in 0.0..1.0) sin(PI * p) else 0.0
        if (doubleBlink && p in 1.3..2.3) closed = sin(PI * (p - 1.3))
        val breathe = sin(now * if (mood == "resting") 1.1 else 1.8)
        return FaceFrame(gazeX.value, gazeY.value, mood, talk, closed, breathe, now, pupil.value, browLift.value,
            browTilt.value, lean.value, hop.value, blush.value, squint.value.coerceIn(0.0, 1.0))
    }

    companion object {
        /** Clamps a gaze vector to the unit circle. */
        fun unitGaze(x: Double, y: Double): Pair<Double, Double> {
            val len = hypot(x, y)
            return if (len > 1) Pair(x / len, y / len) else Pair(x, y)
        }
    }
}
