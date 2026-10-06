// Local speech-to-text with whisper.cpp: a whisper-server process kept warm on localhost.
// Free, private and offline: no API, no subscription usage for listening.
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { toWav } = require('./audio');

const MODELS = {
  'base.en': { file: 'ggml-base.en.bin', size: 147964211, language: 'en', label: 'English — fast (recommended)' },
  'small.en': { file: 'ggml-small.en.bin', size: 487614201, language: 'en', label: 'English — more accurate, slower' },
  'base': { file: 'ggml-base.bin', size: 147951465, language: 'auto', label: 'Hindi + English (Hinglish) and 95 more languages — fast' },
  'small': { file: 'ggml-small.bin', size: 487601967, language: 'auto', label: 'Hindi + English (Hinglish) and 95 more languages — accurate, slower' },
};
const MODEL_URL = (file) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${file}`;

/** Things whisper invents for silence or noise. */
const HALLUCINATIONS = /^(\s*(thank you|thanks for watching|you|bye|okay|\.+|subtitles by.*|please subscribe.*)[.!]?\s*)$/i;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

function download(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'Bluey' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 6) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).toString(), dest, onProgress, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('Download failed: HTTP ' + res.statusCode)); }
      const total = Number(res.headers['content-length']) || 0;
      let got = 0;
      const tmp = dest + '.part';
      const out = fs.createWriteStream(tmp);
      res.on('data', (c) => { got += c.length; if (onProgress) onProgress(got, total); });
      res.pipe(out);
      out.on('finish', () => out.close(() => { fs.renameSync(tmp, dest); resolve(dest); }));
      out.on('error', reject);
      res.on('error', reject);
    }).on('error', reject);
  });
}

class Whisper extends EventEmitter {
  constructor({ binDir, modelDir, model = 'base.en', language }) {
    super();
    this.binDir = binDir;
    this.modelDir = modelDir;
    this.model = MODELS[model] ? model : 'base.en';
    this.language = language || MODELS[this.model].language;
    this.proc = null;
    this.port = 0;
    this.queue = [];
    this.running = false;
    this.state = 'stopped';  // stopped | downloading | starting | ready | error
  }

  get modelPath() { return path.join(this.modelDir, MODELS[this.model].file); }
  get serverExe() { return path.join(this.binDir, 'whisper-server.exe'); }

  setState(state, detail) { this.state = state; this.detail = detail; this.emit('state', { state, detail }); }

  async ensureModel() {
    if (fs.existsSync(this.modelPath) && fs.statSync(this.modelPath).size > 1e6) return;
    fs.mkdirSync(this.modelDir, { recursive: true });
    this.setState('downloading', 0);
    let last = 0;
    await download(MODEL_URL(MODELS[this.model].file), this.modelPath, (got, total) => {
      const pct = total ? Math.floor(got / total * 100) : 0;
      if (pct !== last) { last = pct; this.setState('downloading', pct); }
    });
  }

  async start() {
    if (this.proc || this.starting) return this.starting;
    this.starting = (async () => {
      if (!fs.existsSync(this.serverExe)) throw new Error('whisper-server.exe is missing from ' + this.binDir);
      await this.ensureModel();
      this.setState('starting');
      this.port = await freePort();
      const threads = Math.max(2, Math.min(8, os.cpus().length - 1));
      // An audio context of 768 (about 15 s) makes short clips several times faster; utterances are cut at 14 s.
      const args = ['-m', this.modelPath, '--host', '127.0.0.1', '--port', String(this.port), '-t', String(threads),
        '-ac', '768', '-l', this.language, '-nth', '0.6', '-sns', '-nf'];
      this.proc = spawn(this.serverExe, args, { cwd: this.binDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let log = '';
      const keep = (d) => { log = (log + d).slice(-3000); };
      this.proc.stdout.on('data', keep);
      this.proc.stderr.on('data', keep);
      this.proc.on('exit', (code) => {
        this.proc = null;
        this.starting = null;
        if (this.state !== 'stopped') { this.setState('error', `Speech recognition stopped (code ${code}).`); this.emit('crash', log); }
      });
      for (let i = 0; i < 120; i++) {
        if (!this.proc) throw new Error('Speech recognition failed to start: ' + log.split('\n').filter(Boolean).slice(-2).join(' '));
        if (await this.ping()) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      this.setState('ready');
      // Warm it up so the first real question is quick.
      this.transcribe(new Int16Array(16000)).catch(() => {});
    })();
    try { await this.starting; } catch (e) { this.starting = null; this.setState('error', e.message); throw e; }
    return this.starting;
  }

  ping() {
    return new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: this.port, path: '/', timeout: 1000 }, (res) => { res.resume(); resolve(true); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }

  /** Transcribes 16 kHz PCM. `urgent` jumps the queue (a question beats background talk). */
  transcribe(int16, { urgent = false, prompt } = {}) {
    return new Promise((resolve, reject) => {
      const job = { int16, prompt, resolve, reject };
      if (urgent) this.queue.unshift(job); else this.queue.push(job);
      this.pump();
    });
  }

  async pump() {
    if (this.running || !this.queue.length) return;
    this.running = true;
    const job = this.queue.shift();
    try {
      if (!this.proc) await this.start();
      job.resolve(await this.post(job.int16, job.prompt));
    } catch (e) {
      job.reject(e);
    } finally {
      this.running = false;
      setImmediate(() => this.pump());
    }
  }

  post(int16, prompt) {
    return new Promise((resolve, reject) => {
      const boundary = '----bluey' + Date.now().toString(16);
      const fields = { response_format: 'json', temperature: '0.0' };
      if (prompt) fields.prompt = prompt;
      const parts = [];
      for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n`));
      parts.push(toWav(int16));
      parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
      const body = Buffer.concat(parts);
      const req = http.request({ host: '127.0.0.1', port: this.port, path: '/inference', method: 'POST', timeout: 60000,
        headers: { 'content-type': 'multipart/form-data; boundary=' + boundary, 'content-length': body.length } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (json.error) return reject(new Error(json.error));
            resolve(Whisper.clean(json.text));
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Speech recognition timed out.')); });
      req.end(body);
    });
  }

  static clean(text) {
    let t = String(text || '').replace(/[\u266A\u266B\u266C\u2669]+/g, ' ')  // music notes
      .replace(/\[[^\]]*\]|\([^)]*(music|noise|silence|blank|inaudible|applause|laugh)[^)]*\)/gi, ' ')
      .replace(/\s+/g, ' ').trim();
    if (HALLUCINATIONS.test(t)) return '';
    return t;
  }

  stop() {
    this.setState('stopped');
    if (this.proc) { try { this.proc.kill(); } catch {} this.proc = null; }
    this.starting = null;
  }
}

module.exports = { Whisper, MODELS };
