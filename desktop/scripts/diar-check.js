const sherpa = require('sherpa-onnx-node');
const dir = process.env.APPDATA + '/Bluey/models/diarize';
const sd = new sherpa.OfflineSpeakerDiarization({
  segmentation: { pyannote: { model: dir + '/sherpa-onnx-pyannote-segmentation-3-0/model.onnx' } },
  embedding: { model: dir + '/emb.onnx' },
  clustering: { numClusters: -1, threshold: 0.5 }, minDurationOn: 0.2, minDurationOff: 0.5,
});
const wave = sherpa.readWave('test/fixtures/two-voices.wav');
const t0 = Date.now();
const segs = sd.process(wave.samples);
console.log('ms', Date.now() - t0, 'sampleRate', sd.sampleRate);
for (const s of segs) console.log(s.start.toFixed(2), s.end.toFixed(2), 'speaker', s.speaker);
