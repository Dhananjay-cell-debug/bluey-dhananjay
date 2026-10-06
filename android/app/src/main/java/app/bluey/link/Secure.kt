package app.bluey.link

import java.math.BigInteger
import java.nio.ByteBuffer
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPrivateKeySpec
import java.security.spec.ECPublicKeySpec
import java.security.spec.PKCS8EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * The phone link's security, matching desktop/src/main/secure.js byte for byte: P-256 keys, ECDH + HKDF-SHA256,
 * AES-256-GCM frames with a per-direction counter, and six verification digits shown on both screens while pairing.
 */
object Secure {
    const val PHONE_TO_PC = 1
    const val PC_TO_PHONE = 2
    const val KIND_TEXT: Byte = 1
    const val KIND_AUDIO: Byte = 2
    private val INFO = "bluey-link-v2".toByteArray()

    private val params: ECParameterSpec by lazy {
        val g = KeyPairGenerator.getInstance("EC"); g.initialize(ECGenParameterSpec("secp256r1"))
        (g.generateKeyPair().public as ECPublicKey).params
    }

    fun newKeyPair(): KeyPair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()

    fun privateFromPkcs8(bytes: ByteArray): PrivateKey = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(bytes))

    fun privateFromScalar(hex: String): ECPrivateKey =
        KeyFactory.getInstance("EC").generatePrivate(ECPrivateKeySpec(BigInteger(hex, 16), params)) as ECPrivateKey

    private fun fixed32(n: BigInteger): ByteArray {
        val b = n.toByteArray()
        return when {
            b.size == 32 -> b
            b.size > 32 -> b.copyOfRange(b.size - 32, b.size)
            else -> ByteArray(32 - b.size) + b
        }
    }

    /** 0x04 || x || y, as the PC sends and expects. */
    fun encode(pub: ECPublicKey): ByteArray = byteArrayOf(4) + fixed32(pub.w.affineX) + fixed32(pub.w.affineY)

    fun decode(raw: ByteArray): ECPublicKey {
        require(raw.size == 65 && raw[0] == 4.toByte()) { "bad key" }
        val point = ECPoint(BigInteger(1, raw.copyOfRange(1, 33)), BigInteger(1, raw.copyOfRange(33, 65)))
        return KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(point, params)) as ECPublicKey
    }

    fun verificationNumbers(pcPub: ByteArray, phonePub: ByteArray): String {
        val h = MessageDigest.getInstance("SHA-256").digest(pcPub + phonePub)
        val n = (ByteBuffer.wrap(h, 0, 4).int.toLong() and 0xFFFFFFFFL) % 1_000_000L
        val s = n.toString().padStart(6, '0')
        return s.substring(0, 3) + " " + s.substring(3)
    }

    private fun hmac(key: ByteArray, data: ByteArray): ByteArray =
        Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(key, "HmacSHA256")) }.doFinal(data)

    /** HKDF-SHA256 for a 32-byte output (one block). */
    fun hkdf32(ikm: ByteArray, salt: ByteArray, info: ByteArray): ByteArray {
        val prk = hmac(salt, ikm)
        return hmac(prk, info + byteArrayOf(1))
    }

    fun sessionKey(mine: PrivateKey, theirs: ByteArray, phoneNonce: ByteArray, pcNonce: ByteArray): ByteArray {
        val agreement = KeyAgreement.getInstance("ECDH")
        agreement.init(mine)
        agreement.doPhase(decode(theirs), true)
        return hkdf32(agreement.generateSecret(), phoneNonce + pcNonce, INFO)
    }

    /** One encrypted connection from the phone's side. */
    class Channel(private val key: ByteArray, private val sendDir: Int = PHONE_TO_PC) {
        private val recvDir = if (sendDir == PHONE_TO_PC) PC_TO_PHONE else PHONE_TO_PC
        private var sendCounter = 0L
        private var recvCounter = -1L
        private val secret = SecretKeySpec(key, "AES")

        private fun nonce(dir: Int, counter: Long): ByteArray = ByteBuffer.allocate(12).putInt(dir).putLong(counter).array()

        @Synchronized
        fun seal(kind: Byte, payload: ByteArray, offset: Int = 0, length: Int = payload.size): ByteArray {
            val n = nonce(sendDir, sendCounter++)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, secret, GCMParameterSpec(128, n))
            cipher.update(byteArrayOf(kind))
            val body = cipher.doFinal(payload, offset, length)
            return n + body
        }

        /** Returns (kind, payload), or null for a forged, replayed or out-of-order frame. */
        @Synchronized
        fun open(frame: ByteArray): Pair<Byte, ByteArray>? {
            if (frame.size < 12 + 1 + 16) return null
            val buf = ByteBuffer.wrap(frame, 0, 12)
            if (buf.int != recvDir) return null
            val counter = buf.long
            if (counter <= recvCounter) return null
            return try {
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.DECRYPT_MODE, secret, GCMParameterSpec(128, frame, 0, 12))
                val plain = cipher.doFinal(frame, 12, frame.size - 12)
                recvCounter = counter
                Pair(plain[0], plain.copyOfRange(1, plain.size))
            } catch (e: Exception) {
                null
            }
        }
    }
}
