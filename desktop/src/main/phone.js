// The link to the Android phone(s): a WebSocket server on the local network, advertised with mDNS (_bluey._tcp)
// so the phone finds the PC by itself (or over USB through `adb reverse`, see usb.js).
//
// Security (see secure.js): the first frame each way is a plain "hello" with the device's public key and a fresh
// nonce; everything after is AES-GCM encrypted. A new phone shows six digits, the PC shows the same six digits
// with an Allow button, and only then can it send commands or audio. Paired phones are recognised by their key.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const { EventEmitter } = require('events');
const { WebSocketServer } = require('ws');
const secure = require('./secure');
const { apkInfo } = require('./apkinfo');

const PORT = Number(process.env.BLUEY_PHONE_PORT) || 47613;
const PROTOCOL = 2;

class PhoneServer extends EventEmitter {
  /**
   * @param o.devices  paired phones [{device, name, pub (base64), added}]
   * @param o.save(devices)  persists them
   * @param o.identity  this PC's key pair (secure.loadIdentity)
   */
  constructor({ devices, save, name, identity, apk }) {
    super();
    this.apk = apk;
    this.devices = (devices || []).filter((d) => d.pub);
    this.saveDevices = save;
    this.name = name || os.hostname();
    this.identity = identity;
    this.phones = new Map();  // ws -> info
    this.lastFace = null;
    this.lastFaceAt = 0;
    this.pending = new Map();  // pub -> pairing request
  }

  async start() {
    this.wss = await new Promise((resolve) => {
      const tryListen = (port) => {
        // One port for both: the WebSocket link, and a tiny web page the phone's browser can download the app from.
        const server = http.createServer((req, res) => this.page(req, res));
        const wss = new WebSocketServer({ server, maxPayload: 8 * 1024 * 1024, perMessageDeflate: false });
        wss.on('error', () => {});  // listen errors are handled on the HTTP server below
        server.once('listening', () => { this.http = server; resolve(wss); });
        server.once('error', (e) => {
          if (port !== 0) tryListen(0);
          else { this.emit('warning', 'Phone link could not start: ' + e.message); resolve(null); }
        });
        server.listen(port, '0.0.0.0');
      };
      tryListen(PORT);
    });
    if (!this.wss) return;
    this.port = this.http.address().port;
    this.wss.on('connection', (ws, req) => this.accept(ws, req));
    this.advertise();
    this.heartbeat = setInterval(() => {
      for (const ws of this.phones.keys()) {
        if (ws.isAlive === false) { ws.terminate(); continue; }
        ws.isAlive = false;
        try { ws.ping(); } catch {}
      }
    }, 5000);
  }

  advertise() {
    try {
      const { Bonjour } = require('bonjour-service');
      this.bonjour = new Bonjour();
      this.service = this.bonjour.publish({ name: this.name.slice(0, 60), type: 'bluey', protocol: 'tcp', port: this.port,
        txt: { v: String(PROTOCOL), host: os.hostname() } });
      this.service.on('error', (e) => this.emit('warning', 'Discovery problem: ' + e.message));
    } catch (e) {
      this.emit('warning', 'Discovery unavailable: ' + e.message);
    }
  }

  /** The download page: open http://<this PC>:47613 in the phone's browser (or scan the QR code) to get the app. */
  page(req, res) {
    const url = (req.url || '/').split('?')[0];
    if (url === '/Bluey.apk' && this.apk && fs.existsSync(this.apk)) {
      const size = fs.statSync(this.apk).size;
      res.writeHead(200, { 'content-type': 'application/vnd.android.package-archive', 'content-length': size,
        'content-disposition': 'attachment; filename="Bluey.apk"' });
      this.emit('apkDownload', req.socket.remoteAddress);
      return fs.createReadStream(this.apk).pipe(res);
    }
    if (url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bluey</title>
<body style="margin:0;background:#000;color:#fff;font:18px system-ui,sans-serif;text-align:center;padding:40px 24px">
<div style="width:110px;height:96px;margin:0 auto 18px;border-radius:52% 48% 46% 54%/58% 56% 44% 42%;background:linear-gradient(150deg,#A9BCFF,#6C86F5 34%,#4254D6 68%,#2B2F8F);position:relative">
<i style="position:absolute;left:28px;top:30px;width:22px;height:22px;border-radius:50%;background:#fff"></i><i style="position:absolute;right:28px;top:30px;width:22px;height:22px;border-radius:50%;background:#fff"></i></div>
<h1 style="font-size:28px;margin:0 0 8px">Bluey for Android</h1>
<p style="color:#B9B2CC;margin:0 0 28px">From ${escapeHtml(this.name)}, on your Wi-Fi.</p>
<a href="/Bluey.apk" style="display:inline-block;background:linear-gradient(150deg,#A9BCFF,#4254D6);color:#fff;text-decoration:none;padding:16px 28px;border-radius:16px;font-weight:700">Download Bluey</a>
<p style="color:#B9B2CC;font-size:15px;line-height:1.5;margin-top:28px">Then open the downloaded file and tap <b>Install</b>.<br>If Android asks, allow installing apps from your browser.<br>Open Bluey, and click <b>Allow</b> on the PC when the numbers match.</p></body>`);
    }
    res.writeHead(404); res.end();
  }

  /** Every LAN address, for typing into the phone by hand. */
  addresses() {
    const out = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
    return out;
  }

  accept(ws, req) {
    const info = { name: 'Phone', device: null, paired: false, channel: null, pub: null, address: req.socket.remoteAddress, bad: 0 };
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    this.phones.set(ws, info);
    ws.on('message', (data, isBinary) => {
      if (!info.channel) {
        if (isBinary) return ws.close(1002, 'hello first');
        let m;
        try { m = JSON.parse(data.toString('utf8')); } catch { return ws.close(1002, 'bad hello'); }
        return this.hello(ws, info, m);
      }
      if (!isBinary) return;
      const frame = info.channel.open(Buffer.isBuffer(data) ? data : Buffer.from(data));
      if (!frame) { if (++info.bad > 5) ws.close(1008, 'bad frames'); return; }
      if (frame.kind === secure.KIND_AUDIO) {
        if (info.paired) this.emit('audio', { phone: info, data: frame.payload });
        return;
      }
      let m;
      try { m = JSON.parse(frame.payload.toString('utf8')); } catch { return; }
      this.onMessage(ws, info, m);
    });
    const since = Date.now();
    ws.on('close', (code, reason) => {
      this.emit('closed', { name: info.name, address: info.address, code, reason: String(reason || ''), seconds: Math.round((Date.now() - since) / 1000), paired: info.paired });
      this.phones.delete(ws);
      if (info.pub) {
        const p = this.pending.get(info.pub);
        if (p && p.ws === ws) { this.pending.delete(info.pub); this.emit('pairRequest', null); }
      }
      if (info.paired) this.emit('phones', this.list());
      this.emit('disconnect', info);
    });
    ws.on('error', () => {});
  }

  hello(ws, info, m) {
    if (m.t !== 'hello') return ws.close(1002, 'hello first');
    if (m.v !== PROTOCOL) {
      try { ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL, upgrade: true, name: this.name })); } catch {}
      return ws.close(1002, 'update the app');
    }
    let phonePub, phoneNonce;
    try {
      phonePub = Buffer.from(String(m.pub || ''), 'base64');
      phoneNonce = Buffer.from(String(m.nonce || ''), 'base64');
    } catch { return ws.close(1002, 'bad key'); }
    if (phonePub.length !== 65 || phonePub[0] !== 4 || phoneNonce.length !== 16) return ws.close(1002, 'bad key');
    let key;
    const pcNonce = crypto.randomBytes(16);
    try { key = secure.sessionKey(this.identity, phonePub, phoneNonce, pcNonce); } catch { return ws.close(1002, 'bad key'); }
    info.name = String(m.name || 'Phone').slice(0, 60);
    info.device = String(m.device || '').slice(0, 80) || null;
    info.pub = phonePub.toString('base64');
    info.channel = new secure.Channel(key, secure.PC_TO_PHONE);
    const known = this.devices.find((d) => d.pub === info.pub);
    try {
      ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL, name: this.name, pub: this.identity.pub.toString('base64'),
        nonce: pcNonce.toString('base64'), paired: !!known }));
    } catch { return; }
    if (known) {
      info.paired = true;
      if (known.name !== info.name) { known.name = info.name; this.saveDevices(this.devices); }
      this.ready(ws, info);
    } else {
      this.requestPairing(ws, info, phonePub);
    }
  }

  ready(ws, info) {
    if (this.lastFace) this.send(ws, { t: 'face', ...this.lastFace });
    this.emit('phones', this.list());
    this.emit('connect', info, ws);
  }

  /** A new phone: show the same six digits as the phone, with Allow / Don't allow on the PC. */
  requestPairing(ws, info, phonePub) {
    const numbers = secure.verificationNumbers(this.identity.pub, phonePub);
    const request = {
      ws, name: info.name, numbers,
      allow: () => {
        if (this.pending.get(info.pub) !== request) return;
        this.pending.delete(info.pub);
        this.devices = this.devices.filter((d) => d.pub !== info.pub && !(info.device && d.device === info.device));
        this.devices.push({ device: info.device, name: info.name, pub: info.pub, added: Date.now() });
        this.saveDevices(this.devices);
        info.paired = true;
        this.send(ws, { t: 'paired', name: this.name });
        this.emit('pairRequest', null);
        this.ready(ws, info);
      },
      deny: () => {
        if (this.pending.get(info.pub) !== request) return;
        this.pending.delete(info.pub);
        this.send(ws, { t: 'pairDenied' });
        this.emit('pairRequest', null);
        setTimeout(() => ws.close(1000, 'denied'), 300);
      },
    };
    this.pending.set(info.pub, request);
    this.emit('pairRequest', request);
  }

  onMessage(ws, info, m) {
    if (m.t === 'ping') return this.send(ws, { t: 'pong', rid: m.rid });
    if (!info.paired) return;
    if (m.t === 'phoneResult') {
      const w = this.asks && this.asks.get(m.prid);
      if (w) { this.asks.delete(m.prid); clearTimeout(w.timer); w.resolve(m); }
      return;
    }
    if (m.t === 'caps') {
      info.hands = !!m.hands; info.lite = !!m.lite; info.voice = !!m.voice; info.version = m.version || null; info.versionCode = Number(m.versionCode) || 0;
      this.emit('caps', { name: info.name, hands: info.hands, lite: info.lite, version: info.version, versionCode: info.versionCode });
      this.emit('phones', this.list());
      this.offerUpdate(ws, info);
      return;
    }
    if (m.t === 'updateStatus') { info.update = { state: String(m.state || ''), detail: String(m.detail || '').slice(0, 200), at: Date.now() }; this.emit('updateStatus', { name: info.name, ...info.update }); return; }
    if (m.t === 'voiceStatus') { info.playback = { id: m.id || null, playing: !!m.playing, error: m.error || null, at: Date.now() }; this.emit('voiceStatus', info.playback); return; }
    this.emit('command', m, info, (reply) => this.send(ws, { ...reply, rid: m.rid }));
  }

  /** An older phone app is told about the newer Bluey.apk this PC has, with its size and SHA-256, so it can update itself. */
  offerUpdate(ws, info) {
    const offer = this.apk && apkInfo(this.apk);
    if (!offer || !offer.versionCode || !info.versionCode || info.versionCode >= offer.versionCode) return;
    this.send(ws, { t: 'update', ...offer, path: '/Bluey.apk' });
    this.emit('updateOffered', { name: info.name, from: info.versionCode, to: offer.versionCode });
  }

  /** The phone Bluey can use (hands switched on), preferring the one that's connected now. */
  handsPhone() {
    for (const [ws, info] of this.phones) if (info.paired && info.hands) return { ws, info };
    for (const [ws, info] of this.phones) if (info.paired) return { ws, info };
    return null;
  }

  /** Asks the phone to look or act; resolves with {text, image?}. */
  phoneTool(tool, args, timeout = 30000) {
    const target = this.handsPhone();
    if (!target) return Promise.resolve({ text: "Your phone isn't connected to Bluey right now." });
    this.asks = this.asks || new Map();
    const prid = 'p' + crypto.randomBytes(6).toString('hex');
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.asks.delete(prid); resolve({ text: 'The phone took too long to answer.' }); }, timeout);
      this.asks.set(prid, { resolve, timer });
      this.send(target.ws, { t: 'phoneCmd', prid, tool, args: args || {}, image: tool === 'phone_look' });
    });
  }

  /** The newest pairing request still waiting for Allow, if any. */
  get pendingRequest() { return [...this.pending.values()].pop() || null; }

  forget(id) {
    this.devices = this.devices.filter((d) => !d.pub.startsWith(id));
    this.saveDevices(this.devices);
    for (const [ws, info] of this.phones) if (info.paired && !this.devices.find((d) => d.pub === info.pub)) ws.close();
  }

  list() { return [...this.phones.values()].filter((p) => p.paired).map((p) => p.name); }
  get connected() { return this.list().length > 0; }

  /** Speak on one connected phone; older apps keep using the PC speaker. */
  speak(message) {
    for (const [ws, info] of this.phones) {
      if (info.paired && info.voice && ws.readyState === 1) {
        this.send(ws, { ...message, t: 'voice' });
        return true;
      }
    }
    return false;
  }

  send(ws, obj) {
    const info = this.phones.get(ws);
    if (!info || !info.channel || ws.readyState !== 1) return;
    try { ws.send(info.channel.sealJson(obj)); } catch {}
  }

  broadcast(obj) {
    for (const [ws, info] of this.phones) if (info.paired) this.send(ws, obj);
  }

  sendTo(target, obj) {
    for (const [ws, info] of this.phones) if (info === target) this.send(ws, obj);
  }

  /** The face, skipping updates too small to see (but at least once a second so the phone knows we're here). */
  face(face) {
    const now = Date.now();
    const last = this.lastFace;
    if (last && now - this.lastFaceAt < 1000 && last.mood === face.mood && Math.abs(last.gx - face.gx) < 0.004
      && Math.abs(last.gy - face.gy) < 0.004 && Math.abs(last.talk - face.talk) < 0.02) return;
    this.lastFace = { gx: +face.gx.toFixed(4), gy: +face.gy.toFixed(4), mood: face.mood, talk: +face.talk.toFixed(3) };
    this.lastFaceAt = now;
    this.broadcast({ t: 'face', ...this.lastFace });
  }

  stop() {
    clearInterval(this.heartbeat);
    try { if (this.service) this.service.stop(); } catch {}
    try { if (this.bonjour) this.bonjour.destroy(); } catch {}
    try { if (this.wss) this.wss.close(); } catch {}
    try { if (this.http) this.http.close(); } catch {}
  }
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

module.exports = { PhoneServer, PORT, PROTOCOL };
