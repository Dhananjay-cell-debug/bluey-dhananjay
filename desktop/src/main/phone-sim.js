// A stand-in for the Android app that speaks the exact same protocol (v2, encrypted). Used by the tests and by
// the QA run to drive the real PC app the way a phone does.
'use strict';

const crypto = require('crypto');
const WebSocket = require('ws');
const { EventEmitter } = require('events');
const secure = require('./secure');

class PhoneSim extends EventEmitter {
  constructor({ name = 'Sim Phone', device = 'sim-' + crypto.randomBytes(4).toString('hex'), identityHex } = {}) {
    super();
    this.name = name;
    this.device = device;
    const ecdh = crypto.createECDH('prime256v1');
    if (identityHex) ecdh.setPrivateKey(Buffer.from(identityHex, 'hex')); else ecdh.generateKeys();
    this.identity = { ecdh, pub: ecdh.getPublicKey(null, 'uncompressed') };
    this.inbox = [];
    this.waiters = [];
  }

  /** Connects and says hello. Resolves with the PC's hello (paired or not) plus the six digits. */
  connect(url) {
    return new Promise((resolve, reject) => {
      const nonce = crypto.randomBytes(16);
      this.ws = new WebSocket(url);
      this.ws.on('error', reject);
      this.ws.on('open', () => this.ws.send(JSON.stringify({ t: 'hello', v: 2, name: this.name, device: this.device,
        pub: this.identity.pub.toString('base64'), nonce: nonce.toString('base64') })));
      this.ws.on('message', (data, binary) => {
        if (!this.channel) {
          const hello = JSON.parse(data.toString());
          if (hello.upgrade) return reject(new Error('protocol mismatch'));
          const pcPub = Buffer.from(hello.pub, 'base64');
          this.channel = new secure.Channel(secure.sessionKey(this.identity, pcPub, nonce, Buffer.from(hello.nonce, 'base64')), secure.PHONE_TO_PC);
          hello.numbers = secure.verificationNumbers(pcPub, this.identity.pub);
          return resolve(hello);
        }
        if (!binary) return;
        const frame = this.channel.open(data);
        if (!frame) { this.emit('bad'); return; }
        const m = JSON.parse(frame.payload.toString('utf8'));
        this.emit('message', m);
        const i = this.waiters.findIndex((w) => w.test(m));
        if (i >= 0) this.waiters.splice(i, 1)[0].resolve(m); else this.inbox.push(m);
      });
      this.ws.on('close', () => this.emit('close'));
    });
  }

  /** Waits for a message matching `test` (a type string or a function). */
  next(test, ms = 10000) {
    const fn = typeof test === 'string' ? (m) => m.t === test : test;
    const i = this.inbox.findIndex(fn);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0]);
    return new Promise((resolve) => {
      const w = { test: fn, resolve };
      this.waiters.push(w);
      setTimeout(() => { const j = this.waiters.indexOf(w); if (j >= 0) { this.waiters.splice(j, 1); resolve(null); } }, ms);
    });
  }

  clear() { this.inbox = []; }
  send(obj) { this.ws.send(this.channel.sealJson(obj)); }
  sendAudio(buf) { this.ws.send(this.channel.seal(secure.KIND_AUDIO, Buffer.from(buf))); }
  close() { try { this.ws.close(); } catch {} }
}

module.exports = { PhoneSim };
