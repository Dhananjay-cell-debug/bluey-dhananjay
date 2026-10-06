// His little cartoon chirp: a few soft, round, bell-like notes from a happy pentatonic scale,
// each with a little upward "boop" at the start, like a small creature humming. (Same recipe as the phone.)
(function (root) {
  let audio = null;
  function play(syllables, volume) {
    if (volume === 0) return;
    audio = audio || new AudioContext({ sampleRate: 24000 });
    if (audio.state === 'suspended') audio.resume();
    const rate = audio.sampleRate;
    const scale = [1046.5, 1174.7, 1318.5, 1568.0, 1760.0, 2093.0, 2349.3, 2637.0];
    let index = 1 + Math.floor(Math.random() * 3);
    const samples = [];
    for (let i = 0; i < syllables; i++) {
      if (i > 0) index = Math.min(Math.max(index + [-1, 1, 1, 2][Math.floor(Math.random() * 4)], 0), scale.length - 1);
      const note = scale[index] * 0.5;  // drop an octave: rounder, less piercing
      const last = i === syllables - 1;
      const duration = last ? 0.13 : 0.07 + Math.random() * 0.02;
      const count = Math.floor(duration * rate);
      let phase = 0;
      for (let n = 0; n < count; n++) {
        const time = n / rate, t = n / count;
        const scoop = 1 - 0.18 * Math.exp(-time / 0.012);
        const wobble = last ? 1 + 0.012 * Math.sin(time * 2 * Math.PI * 18) : 1;
        phase += 2 * Math.PI * note * scoop * wobble / rate;
        const attack = Math.min(1, time / 0.006);
        const envelope = attack * Math.exp(-t * 3.2) * (1 - Math.pow(t, 6));
        samples.push((Math.sin(phase) + 0.12 * Math.sin(2 * phase)) * envelope * 0.26);
      }
      for (let n = 0; n < Math.floor(rate * 0.028); n++) samples.push(0);
    }
    const buffer = audio.createBuffer(1, samples.length, rate);
    buffer.copyToChannel(Float32Array.from(samples), 0);
    const source = audio.createBufferSource();
    const gain = audio.createGain();
    gain.gain.value = volume == null ? 0.8 : volume;
    source.buffer = buffer;
    source.connect(gain).connect(audio.destination);
    source.start();
  }
  root.BlueyChirp = { play };
})(window);
