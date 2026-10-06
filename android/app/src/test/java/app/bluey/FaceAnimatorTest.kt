package app.bluey

import app.bluey.audio.Chirp
import app.bluey.face.FaceAnimator
import app.bluey.face.FaceState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs
import kotlin.random.Random

class FaceAnimatorTest {
    private fun run(a: FaceAnimator, from: Double, seconds: Double, each: (Double) -> Unit = {}) : Double {
        var t = from
        while (t < from + seconds) { t += 1.0 / 60; a.step(t); each(t) }
        return t
    }

    @Test fun eyesFollowWhatThePcSays() {
        val a = FaceAnimator(Random(1))
        var t = 0.0
        repeat(120) { t += 1.0 / 60; a.receive(FaceState(gx = 0.8, gy = -0.4, mood = "listening"), t); a.step(t) }
        val f = a.step(t + 1.0 / 60)
        assertTrue("looks right: ${f.gazeX}", abs(f.gazeX - 0.8) < 0.1)
        assertTrue("looks up: ${f.gazeY}", abs(f.gazeY + 0.4) < 0.1)
        assertEquals("listening", f.mood)
    }

    @Test fun localMoodWinsAndThinkingLooksUpAndAway() {
        val a = FaceAnimator(Random(2))
        a.localMood = "thinking"
        val end = run(a, 0.0, 2.0)
        val f = a.step(end + 1.0 / 60)
        assertEquals("thinking", f.mood)
        assertTrue(f.gazeY < -0.6)
        assertTrue(f.gazeX > 0.4)
    }

    @Test fun withoutThePcHeWandersAndStillBlinks() {
        val a = FaceAnimator(Random(3))
        var blinked = false
        var minX = 9.0; var maxX = -9.0
        run(a, 0.0, 12.0) { t -> val f = a.step(t); if (f.closed > 0.5) blinked = true; minX = minOf(minX, f.gazeX); maxX = maxOf(maxX, f.gazeX) }
        assertTrue("blinks", blinked)
        assertTrue("eyes move around", maxX - minX > 0.3)
    }

    @Test fun everythingStaysFinite() {
        val a = FaceAnimator(Random(4))
        val moods = listOf("listening", "talking", "pointing", "thinking", "happy", "resting", "sleepy")
        var t = 0.0
        for (m in moods) {
            a.localMood = m
            repeat(90) {
                t += 1.0 / 60
                val f = a.step(t)
                for (v in listOf(f.gazeX, f.gazeY, f.talk, f.pupil, f.browLift, f.lean, f.hop, f.blush, f.squint)) assertTrue("$m $v", v.isFinite())
                assertTrue(f.squint in 0.0..1.0)
            }
        }
    }

    @Test fun talkTestMakesHimTalk() {
        val a = FaceAnimator(Random(5))
        a.talkUntil = 3.0
        var peak = 0.0
        run(a, 0.0, 2.0) { t -> peak = maxOf(peak, a.step(t).talk) }
        assertTrue("talk $peak", peak > 0.5)
    }

    @Test fun unitGazeClampsLongVectors() {
        val (x, y) = FaceAnimator.unitGaze(3.0, 4.0)
        assertEquals(0.6, x, 1e-9); assertEquals(0.8, y, 1e-9)
        assertEquals(Pair(0.2, 0.1), FaceAnimator.unitGaze(0.2, 0.1))
    }

    @Test fun chirpIsShortSoftAndInRange() {
        val samples = Chirp().synth(4, Random(6))
        val seconds = samples.size / 24000.0
        assertTrue("length $seconds", seconds in 0.3..0.6)
        val peak = samples.maxOf { abs(it) }
        assertTrue("peak $peak", peak in 0.1f..0.35f)
        assertTrue(samples.all { it.isFinite() })
    }
}
