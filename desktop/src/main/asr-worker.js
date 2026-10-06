// Runs as its own process (Electron as plain Node) and keeps the speech model loaded: NVIDIA Parakeet TDT 0.6B v2
// through sherpa-onnx. Much more accurate than the small Whisper model and quick on a normal CPU, and it never
// leaves this PC. stdin: {id, pcm: <base64 16-bit mono 16 kHz>}; stdout: {id, text, ms}.
'use strict';

const readline = require('readline');
const [, , modelDir, sherpaPath, threadsArg] = process.argv;

let recognizer;
try {
  const sherpa = require(sherpaPath || 'sherpa-onnx-node');
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: modelDir + '/encoder.int8.onnx', decoder: modelDir + '/decoder.int8.onnx', joiner: modelDir + '/joiner.int8.onnx' },
      tokens: modelDir + '/tokens.txt', numThreads: Number(threadsArg) || 4, provider: 'cpu', debug: 0, modelType: 'nemo_transducer',
    },
  });
  process.stdout.write(JSON.stringify({ ready: true }) + '\n');
} catch (e) {
  process.stdout.write(JSON.stringify({ ready: false, error: String(e && e.message || e) }) + '\n');
  process.exit(1);
}

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  let job;
  try { job = JSON.parse(line); } catch { return; }
  const t0 = Date.now();
  try {
    const buf = Buffer.from(job.pcm, 'base64');
    const samples = new Float32Array(buf.length >> 1);
    for (let i = 0; i < samples.length; i++) samples[i] = buf.readInt16LE(i * 2) / 32768;
    const stream = recognizer.createStream();
    stream.acceptWaveform({ samples, sampleRate: 16000 });
    recognizer.decode(stream);
    const r = recognizer.getResult(stream);
    process.stdout.write(JSON.stringify({ id: job.id, text: String(r.text || '').trim(), ms: Date.now() - t0 }) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({ id: job.id, error: String(e && e.message || e) }) + '\n');
  }
});
