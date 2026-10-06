package app.bluey

import app.bluey.link.Secure
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.security.interfaces.ECPublicKey

/** The same vectors as desktop/test/link.test.js: phone and PC must agree byte for byte. */
class SecureTest {
    private fun hex(s: String) = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    private fun ByteArray.hex() = joinToString("") { "%02x".format(it) }

    private val phonePriv = Secure.privateFromScalar("1".repeat(64))
    private val pcPub = hex("04d65a93977caa3d1b081852ff57a79e465f1660577304baead505dd3a48589cf350185e895372df6221ea3a137557e473fddb6755f05bd507c3c533fce9c91285")
    private val phonePub = hex("040217e617f0b6443928278f96999e69a23a4f2c152bdf6d6cdf66e5b80282d4ed194a7debcb97712d2dda3ca85aa8765a56f45fc758599652f2897c65306e5794")
    private val key = "4d9a0b2e82874d9326e93576425c1df5ee8e4535f5d6c79515424252dd509e89"

    @Test fun keysAndNumbersMatchThePc() {
        assertArrayEquals(phonePub, Secure.encode(Secure.decode(phonePub)))
        val k = Secure.sessionKey(phonePriv, pcPub, hex("aa".repeat(16)), hex("bb".repeat(16)))
        assertEquals(key, k.hex())
        assertEquals("281 357", Secure.verificationNumbers(pcPub, phonePub))
    }

    @Test fun framesMatchThePcAndRejectReplaysAndTampering() {
        val sender = Secure.Channel(hex(key), Secure.PHONE_TO_PC)
        val frame = sender.seal(Secure.KIND_TEXT, "{\"t\":\"hi\"}".toByteArray())
        assertEquals("000000010000000000000000ec1ca4a4064e8a3503e7ca19f78a05d25d8d64d1f319a90c1e4abd", frame.hex())
        val pc = Secure.Channel(hex(key), Secure.PC_TO_PHONE)
        val (kind, payload) = pc.open(frame)!!
        assertEquals(Secure.KIND_TEXT, kind)
        assertEquals("{\"t\":\"hi\"}", String(payload))
        assertNull("replay", pc.open(frame))
        val next = sender.seal(Secure.KIND_AUDIO, ByteArray(10))
        val bad = next.copyOf().also { it[15] = (it[15].toInt() xor 1).toByte() }
        assertNull("tampered", pc.open(bad))
        assertEquals(Secure.KIND_AUDIO, pc.open(next)!!.first)
    }

    @Test fun freshKeysRoundTrip() {
        val a = Secure.newKeyPair(); val b = Secure.newKeyPair()
        val ap = Secure.encode(a.public as ECPublicKey); val bp = Secure.encode(b.public as ECPublicKey)
        val n1 = ByteArray(16) { 1 }; val n2 = ByteArray(16) { 2 }
        assertArrayEquals(Secure.sessionKey(a.private, bp, n1, n2), Secure.sessionKey(b.private, ap, n1, n2))
    }
}
