// The phone link's security. Each device has a long-term P-256 key pair. Pairing shows the same six digits on both
// screens (derived from both public keys), and you click Allow on the PC; after that each side remembers the other's
// key. Every frame after the hello is encrypted with AES-256-GCM using a key from ECDH(static keys) + HKDF over fresh
// nonces from both sides, with a per-direction counter so frames can't be replayed or reordered.
// Must match android/.../link/Secure.kt byte for byte (see the shared test vectors in test/link.test.js).
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CURVE = 'prime256v1';
const INFO = Buffer.from('bluey-link-v2');
const PHONE_TO_PC = 1;
const PC_TO_PHONE = 2;
const KIND_TEXT = 1;
const KIND_AUDIO = 2;

/**
 * This PC's long-term key pair, kept in the app's data folder. With `vault` ({seal, unseal}, Windows DPAPI through
 * Electron's safeStorage) the private key is sealed to this Windows account, so a copied file is useless.
 */
function loadIdentity(file, vault) {
  const ecdh = crypto.createECDH(CURVE);
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const hex = saved.sealed ? vault.unseal(Buffer.from(saved.sealed, 'base64')) : saved.priv;
    ecdh.setPrivateKey(Buffer.from(hex, 'hex'));
    if (!saved.sealed && vault) save(file, ecdh, vault);  // upgrade an old plain file
  } catch {
    ecdh.generateKeys();
    save(file, ecdh, vault);
  }
  return identityFrom(ecdh);
}

function save(file, ecdh, vault) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const hex = ecdh.getPrivateKey('hex');
  const body = vault ? { sealed: vault.seal(hex).toString('base64') } : { priv: hex };
  fs.writeFileSync(file, JSON.stringify(body), { mode: 0o600 });
}

function identityFrom(ecdh) {
  return { ecdh, pub: ecdh.getPublicKey(null, 'uncompressed') };
}

function identityFromPrivate(hex) {
  const ecdh = crypto.createECDH(CURVE);
  ecdh.setPrivateKey(Buffer.from(hex, 'hex'));
  return identityFrom(ecdh);
}

/** The six digits both screens show while pairing, like "721 741". */
function verificationNumbers(pcPub, phonePub) {
  const h = crypto.createHash('sha256').update(Buffer.concat([pcPub, phonePub])).digest();
  const n = h.readUInt32BE(0) % 1000000;
  const s = String(n).padStart(6, '0');
  return s.slice(0, 3) + ' ' + s.slice(3);
}

function sessionKey(identity, theirPub, phoneNonce, pcNonce) {
  const shared = identity.ecdh.computeSecret(theirPub);
  return Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([phoneNonce, pcNonce]), INFO, 32));
}

/** One encrypted connection. `sendDir` is this side's direction. */
class Channel {
  constructor(key, sendDir) {
    this.key = key;
    this.sendDir = sendDir;
    this.recvDir = sendDir === PC_TO_PHONE ? PHONE_TO_PC : PC_TO_PHONE;
    this.sendCounter = 0n;
    this.recvCounter = -1n;
  }

  nonce(dir, counter) {
    const n = Buffer.alloc(12);
    n.writeUInt32BE(dir, 0);
    n.writeBigUInt64BE(counter, 4);
    return n;
  }

  seal(kind, payload) {
    const nonce = this.nonce(this.sendDir, this.sendCounter++);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, nonce);
    const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from([kind]), payload])), cipher.final()]);
    return Buffer.concat([nonce, body, cipher.getAuthTag()]);
  }

  /** Returns {kind, payload} or null if the frame is forged, replayed or out of order. */
  open(frame) {
    if (!Buffer.isBuffer(frame) || frame.length < 12 + 1 + 16) return null;
    const nonce = frame.subarray(0, 12);
    if (nonce.readUInt32BE(0) !== this.recvDir) return null;
    const counter = nonce.readBigUInt64BE(4);
    if (counter <= this.recvCounter) return null;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, nonce);
      decipher.setAuthTag(frame.subarray(frame.length - 16));
      const plain = Buffer.concat([decipher.update(frame.subarray(12, frame.length - 16)), decipher.final()]);
      this.recvCounter = counter;
      return { kind: plain[0], payload: plain.subarray(1) };
    } catch {
      return null;
    }
  }

  sealJson(obj) { return this.seal(KIND_TEXT, Buffer.from(JSON.stringify(obj), 'utf8')); }
}

module.exports = { loadIdentity, identityFromPrivate, verificationNumbers, sessionKey, Channel, PHONE_TO_PC, PC_TO_PHONE, KIND_TEXT, KIND_AUDIO };
