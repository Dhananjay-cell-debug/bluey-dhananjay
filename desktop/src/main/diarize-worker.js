// Runs in its own process (Electron as Node): who spoke when in one WAV file, with sherpa-onnx
// (pyannote segmentation + 3D-Speaker voice fingerprints). Prints JSON segments: [{start, end, speaker}].
'use strict';

const [, , wavPath, modelDir, sherpaPath] = process.argv;
try {
  const sherpa = require(sherpaPath || 'sherpa-onnx-node');
  const sd = new sherpa.OfflineSpeakerDiarization({
    segmentation: { pyannote: { model: modelDir + '/sherpa-onnx-pyannote-segmentation-3-0/model.onnx' }, numThreads: 2 },
    embedding: { model: modelDir + '/emb.onnx', numThreads: 2 },
    clustering: { numClusters: -1, threshold: 0.5 },
    minDurationOn: 0.2,
    minDurationOff: 0.5,
  });
  // Read the 16 kHz PCM16 WAV here (sherpa's own reader uses external buffers, which Electron doesn't allow).
  const buf = require('fs').readFileSync(wavPath);
  let offset = 12, data = null;
  while (offset < buf.length - 8) {
    const id = buf.toString('ascii', offset, offset + 4), size = buf.readUInt32LE(offset + 4);
    if (id === 'data') { data = buf.subarray(offset + 8, Math.min(buf.length, offset + 8 + size)); break; }
    offset += 8 + size;
  }
  if (!data) throw new Error('no audio in ' + wavPath);
  const samples = new Float32Array(data.length >> 1);
  for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2) / 32768;
  const segments = sd.process(samples).map((s) => ({ start: +s.start.toFixed(2), end: +s.end.toFixed(2), speaker: s.speaker }));
  process.stdout.write(JSON.stringify({ ok: true, segments }));
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
}
