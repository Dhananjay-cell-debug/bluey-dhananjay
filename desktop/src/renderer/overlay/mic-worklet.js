// Turns the microphone into 16 kHz PCM16 pieces of about 100 ms for the main process.
class BlueyMic extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = new Int16Array(1600); this.fill = 0; }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      this.buffer[this.fill++] = Math.max(-32768, Math.min(32767, Math.round(input[i] * 32767)));
      if (this.fill === this.buffer.length) {
        this.port.postMessage(this.buffer.buffer, [this.buffer.buffer]);
        this.buffer = new Int16Array(1600);
        this.fill = 0;
      }
    }
    return true;
  }
}
registerProcessor('bluey-mic', BlueyMic);
