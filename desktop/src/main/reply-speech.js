'use strict';

/** Prepare sentences ahead, play in order, and discard every stale result on interruption. */
class ReplySpeech {
  constructor({ synth, deliver, stopped, warning, started }) {
    Object.assign(this, { synth, deliver, stopped, warning, started });
    this.epoch = 0;
    this.serial = 0;
    this.jobs = [];
    this.current = null;
  }

  cancel() {
    this.epoch++;
    clearTimeout(this.timer);
    this.current = null;
    this.jobs = [];
    this.stopped();
  }

  async add(text, { local = false } = {}) {
    if (!text.trim()) return;
    const job = { id: `voice-${this.epoch}-${++this.serial}`, text, epoch: this.epoch, ready: false };
    this.jobs.push(job);
    try { job.audio = local ? null : await this.synth(text); }
    catch (e) { if (job.epoch === this.epoch) this.warning(e); }
    if (job.epoch !== this.epoch) return;
    job.ready = true;
    this.pump();
  }

  pump() {
    if (this.current || !this.jobs[0]?.ready) return;
    const job = this.jobs.shift();
    this.current = job;
    // Old phone versions don't acknowledge playback. Keep their sentences separated too.
    const seconds = job.audio ? job.audio.length / 6000 : job.text.split(/\s+/).length * 0.4;
    this.timer = setTimeout(() => this.played({ id: job.id, playing: false }), Math.max(2200, seconds * 1000 + 1200));
    this.timer.unref?.();
    this.deliver({ id: job.id, text: job.text, ...(job.audio ? { base64: job.audio.toString('base64') } : {}) });
  }

  played(message) {
    if (!this.current || message.id !== this.current.id) return;
    if (message.playing) { this.started?.(message); return; }
    clearTimeout(this.timer);
    this.current = null;
    this.pump();
  }
}

module.exports = { ReplySpeech };
