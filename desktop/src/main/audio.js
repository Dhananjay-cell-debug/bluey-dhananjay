// The session's ears. Raw 16 kHz mono PCM (from the phone or this PC's mic) comes in; out come
// - utterances, found with a simple adaptive voice-activity detector (for "overheard" context and notes),
// - the question you said while holding to ask (the exact audio between your press and release),
// - five-minute WAV chunks of the whole session for the meeting-notes folder.
'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const RATE = 16000;
const FRAME = 480;  // 30 ms

function wavHeader(samples, rate = RATE) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + samples * 2, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(samples * 2, 40);
  return h;
}

function toWav(int16) {
  const body = Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength);
  return Buffer.concat([wavHeader(int16.length), body]);
}

function rms(int16, start = 0, end = int16.length) {
  let sum = 0;
  for (let i = start; i < end; i++) sum += int16[i] * int16[i];
  return Math.sqrt(sum / Math.max(1, end - start)) / 32768;
}

/** Writes the session's audio as five-minute WAV chunks, fixing up each header as it grows. */
class ChunkWriter {
  constructor(folder, chunkSeconds = 300, onChunk) {
    this.onChunk = onChunk;
    this.folder = folder;
    this.chunkSamples = chunkSeconds * RATE;
    this.index = 0;
    this.fd = null;
    this.samples = 0;
  }

  write(int16) {
    if (!this.folder) return;
    let offset = 0;
    while (offset < int16.length) {
      if (this.fd === null) this.open();
      const room = this.chunkSamples - this.samples;
      const n = Math.min(room, int16.length - offset);
      const part = int16.subarray(offset, offset + n);
      fs.writeSync(this.fd, Buffer.from(part.buffer, part.byteOffset, part.byteLength));
      this.samples += n;
      offset += n;
      if (this.samples >= this.chunkSamples) this.close();
    }
  }

  open() {
    fs.mkdirSync(this.folder, { recursive: true });
    this.index++;
    this.file = path.join(this.folder, `chunk-${String(this.index).padStart(3, '0')}.wav`);
    this.fd = fs.openSync(this.file, 'w');
    this.startedAt = Date.now();
    fs.writeSync(this.fd, wavHeader(0));
    this.samples = 0;
  }

  close() {
    if (this.fd === null) return;
    const header = wavHeader(this.samples);
    fs.writeSync(this.fd, header, 0, 44, 0);
    fs.closeSync(this.fd);
    this.fd = null;
    if (this.onChunk && this.samples > RATE) this.onChunk({ file: this.file, index: this.index, startedAt: this.startedAt, seconds: this.samples / RATE });
  }
}

class AudioSession extends EventEmitter {
  constructor({ audioFolder, keepAudio = true } = {}) {
    super();
    this.total = 0;               // samples received so far (the session's audio clock)
    this.buffer = [];             // recent audio, as chunks with their start sample
    this.keepSeconds = 120;
    this.writer = keepAudio && audioFolder ? new ChunkWriter(audioFolder, 300, (c) => this.emit('chunk', c)) : null;
    // Voice activity detection.
    this.noise = 0.004;
    this.inSpeech = false;
    this.speechStart = 0;
    this.lastVoice = 0;
    this.voiceFrames = 0;
    this.pending = new Int16Array(0);
    this.asks = [];               // { start, end } sample ranges said while holding
    this.holding = null;
    this.level = 0;
  }

  get seconds() { return this.total / RATE; }

  /** Feeds PCM16 (Int16Array or Buffer of little-endian samples). */
  push(data) {
    const int16 = data instanceof Int16Array ? data : new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength - (data.byteLength % 2)));
    if (!int16.length) return;
    this.buffer.push({ start: this.total, samples: int16 });
    this.total += int16.length;
    const cutoff = this.total - this.keepSeconds * RATE;
    while (this.buffer.length && this.buffer[0].start + this.buffer[0].samples.length < cutoff) this.buffer.shift();
    if (this.writer) { try { this.writer.write(int16); } catch (e) { this.emit('warning', 'Could not save audio: ' + e.message); this.writer = null; } }
    this.detect(int16);
  }

  /** Copies audio between two sample positions (clamped to what's still buffered). */
  slice(from, to) {
    from = Math.max(0, Math.floor(from)); to = Math.min(this.total, Math.floor(to));
    const out = new Int16Array(Math.max(0, to - from));
    for (const chunk of this.buffer) {
      const a = Math.max(from, chunk.start), b = Math.min(to, chunk.start + chunk.samples.length);
      if (b > a) out.set(chunk.samples.subarray(a - chunk.start, b - chunk.start), a - from);
    }
    return out;
  }

  detect(int16) {
    let pending = new Int16Array(this.pending.length + int16.length);
    pending.set(this.pending); pending.set(int16, this.pending.length);
    let offset = 0;
    const base = this.total - pending.length;
    while (pending.length - offset >= FRAME) {
      const level = rms(pending, offset, offset + FRAME);
      const at = base + offset;
      offset += FRAME;
      this.level = level;
      // The noise floor follows quiet stretches quickly and loud ones very slowly.
      this.noise += (level - this.noise) * (level < this.noise ? 0.05 : 0.0015);
      this.noise = Math.max(this.noise, 0.0008);
      const voiced = level > Math.max(this.noise * 3.2, 0.006);
      if (voiced) {
        this.voiceFrames++;
        this.lastVoice = at + FRAME;
        if (!this.inSpeech && this.voiceFrames >= 3) {
          this.inSpeech = true;
          this.speechStart = Math.max(0, at - FRAME * 10);  // keep a little lead-in
        }
      } else {
        this.voiceFrames = Math.max(0, this.voiceFrames - 1);
      }
      if (this.inSpeech) {
        const silence = (at + FRAME - this.lastVoice) / RATE;
        const length = (at + FRAME - this.speechStart) / RATE;
        if (silence > 0.7 || length > 14) this.endUtterance(this.lastVoice + FRAME * 6);
      }
    }
    this.pending = pending.slice(offset);
  }

  endUtterance(end) {
    this.inSpeech = false;
    this.voiceFrames = 0;
    const start = this.speechStart;
    if ((end - start) / RATE < 0.35) return;
    // Speech said while holding is the question, not background talk.
    const overlap = this.asks.concat(this.holding ? [{ start: this.holding.start, end: Infinity }] : [])
      .reduce((sum, a) => sum + Math.max(0, Math.min(end, a.end) - Math.max(start, a.start)), 0);
    if (overlap > (end - start) * 0.4) return;
    this.emit('utterance', { start, end, audio: this.slice(start, end), at: Date.now() - ((this.total - start) / RATE) * 1000 });
  }

  /** You pressed and held: what you say from now is the question. */
  beginAsk() {
    this.holding = { start: Math.max(0, this.total - RATE * 0.25), startedAt: Date.now() };
  }

  /** You let go: resolves with the audio of your question (waiting a moment for the last bit to arrive). */
  endAsk(tailMs = 350) {
    const hold = this.holding;
    this.holding = null;
    if (!hold) return Promise.resolve(null);
    // The question ends a moment after you let go (the last syllable is often still in flight), never later.
    const until = this.total + Math.round(tailMs / 1000 * RATE);
    const range = { start: hold.start, end: until };
    this.asks.push(range);  // right away, so background talk detection skips it
    if (this.asks.length > 50) this.asks.shift();
    return new Promise((resolve) => {
      setTimeout(() => {
        const end = Math.min(this.total, until);
        const audio = this.slice(hold.start, end);
        resolve({ audio, seconds: audio.length / RATE, level: rms(audio) });
      }, tailMs);
    });
  }

  finish() {
    if (this.inSpeech) this.endUtterance(this.total);
    if (this.writer) { try { this.writer.close(); } catch {} }
  }
}

module.exports = { AudioSession, ChunkWriter, toWav, wavHeader, rms, RATE };
