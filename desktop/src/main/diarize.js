// Speaker labels for the meeting notes: each finished five-minute audio chunk is analysed in the background
// (one at a time, in a separate process so Bluey never stutters), then the lines said during it get
// "Speaker A", "Speaker B"… Letters are per chunk, like the original app.
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');

const MODELS = [
  { file: 'emb.onnx', url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx' },
  { file: 'sherpa-onnx-pyannote-segmentation-3-0/model.onnx', url: 'https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.onnx' },
];

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'Bluey' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 6) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).toString(), dest, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const out = fs.createWriteStream(dest + '.part');
      res.pipe(out);
      out.on('finish', () => out.close(() => { fs.renameSync(dest + '.part', dest); resolve(); }));
      out.on('error', reject);
    }).on('error', reject);
  });
}

class Diarizer extends EventEmitter {
  constructor({ modelDir, sherpaPath, worker }) {
    super();
    this.modelDir = modelDir;
    this.sherpaPath = sherpaPath;
    this.worker = worker;
    this.queue = [];
    this.busy = false;
  }

  async ensureModels() {
    for (const m of MODELS) {
      const dest = path.join(this.modelDir, m.file);
      if (!fs.existsSync(dest)) await download(m.url, dest);
    }
  }

  /** Who spoke when in a WAV file: resolves [{start, end, speaker}] (seconds, speaker 0, 1, …). */
  analyse(file) {
    return new Promise((resolve, reject) => { this.queue.push({ file, resolve, reject }); this.pump(); });
  }

  async pump() {
    if (this.busy || !this.queue.length) return;
    this.busy = true;
    const job = this.queue.shift();
    try {
      await this.ensureModels();
      const result = await new Promise((resolve) => {
        execFile(process.execPath, [this.worker, job.file, this.modelDir, this.sherpaPath],
          { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 15 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 },
          (error, stdout) => { try { resolve(JSON.parse(stdout)); } catch { resolve({ ok: false, error: error ? error.message : 'no output' }); } });
      });
      if (result.ok) job.resolve(result.segments); else job.reject(new Error(result.error));
    } catch (e) {
      job.reject(e);
    } finally {
      this.busy = false;
      setImmediate(() => this.pump());
    }
  }
}

/** Maps segments of one chunk (which started at `chunkStart` ms) onto letters A, B, … in order of first appearance. */
function speakerAt(segments, chunkStart, time) {
  const t = (time - chunkStart) / 1000 + 0.4;  // a moment into the line
  let best = null, bestDist = Infinity;
  for (const s of segments) {
    const d = t < s.start ? s.start - t : t > s.end ? t - s.end : 0;
    if (d < bestDist) { bestDist = d; best = s; }
  }
  if (!best || bestDist > 2) return null;
  const order = [];
  for (const s of segments) if (!order.includes(s.speaker)) order.push(s.speaker);
  return String.fromCharCode(65 + order.indexOf(best.speaker));
}

module.exports = { Diarizer, speakerAt };
