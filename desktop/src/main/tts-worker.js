// Runs as its own process (Electron as plain Node) and keeps the neural voice loaded.
// Reads lines of JSON on stdin: {id, text, sid, speed}; writes {id, rate, wav: <base64 16-bit mono WAV>} on stdout.
// Offline, free and private: Kokoro (a natural-sounding neural voice) through sherpa-onnx.
'use strict';

const readline = require('readline');
const [, , modelDir, sherpaPath, threadsArg] = process.argv;

let tts;
try {
  const sherpa = require(sherpaPath || 'sherpa-onnx-node');
  tts = new sherpa.OfflineTts({
    model: {
      kokoro: {
        model: modelDir + '/model.int8.onnx', voices: modelDir + '/voices.bin', tokens: modelDir + '/tokens.txt',
        dataDir: modelDir + '/espeak-ng-data', dictDir: modelDir + '/dict', lexicon: modelDir + '/lexicon-us-en.txt',
      },
      debug: false, numThreads: Number(threadsArg) || 4, provider: 'cpu',
    },
    maxNumSentences: 1,
  });
  process.stdout.write(JSON.stringify({ ready: true, speakers: tts.numSpeakers, rate: tts.sampleRate }) + '\n');
} catch (e) {
  process.stdout.write(JSON.stringify({ ready: false, error: String(e && e.message || e) }) + '\n');
  process.exit(1);
}

function wav(samples, rate) {
  const n = samples.length, out = Buffer.alloc(44 + n * 2);
  out.write('RIFF', 0); out.writeUInt32LE(36 + n * 2, 4); out.write('WAVE', 8); out.write('fmt ', 12);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  return out;
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let job;
  try { job = JSON.parse(line); } catch { return; }
  const t0 = Date.now();
  try {
    // Sentence by sentence, so the first words can start playing while the rest is still being made.
    const parts = String(job.text).replace(/\s+/g, ' ').match(/[^.!?…]+[.!?…]*/g) || [job.text];
    parts.forEach((part, i) => {
      if (!part.trim()) return;
      const audio = tts.generate({ text: part.trim(), sid: job.sid == null ? 3 : job.sid, speed: job.speed || 1.0 });
      process.stdout.write(JSON.stringify({ id: job.id, part: i, parts: parts.length, rate: audio.sampleRate, ms: Date.now() - t0, wav: wav(audio.samples, audio.sampleRate).toString('base64') }) + '\n');
    });
    process.stdout.write(JSON.stringify({ id: job.id, done: true }) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({ id: job.id, error: String(e && e.message || e) }) + '\n');
  }
});
