// Talks to BlueyNative.exe (screen, OCR, controls, mouse, keyboard, push-to-talk key hook).
// One request per line, replies matched by id; restarts itself if the helper ever crashes.
'use strict';

const { spawn } = require('child_process');
const readline = require('readline');
const { EventEmitter } = require('events');

class Native extends EventEmitter {
  constructor(exe) {
    super();
    this.exe = exe;
    this.proc = null;
    this.nextId = 1;
    this.waiting = new Map();
    this.restarts = 0;
    this.hookConfig = null;
  }

  start() {
    if (this.proc) return;
    this.proc = spawn(this.exe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdin.on('error', () => {});
    this.proc.stderr.on('data', (d) => this.emit('log', String(d)));
    readline.createInterface({ input: this.proc.stdout }).on('line', (line) => {
      let m;
      try { m = JSON.parse(line); } catch { return; }
      if (m.event) { this.emit(m.event, m); return; }
      const w = this.waiting.get(m.id);
      if (!w) return;
      this.waiting.delete(m.id);
      clearTimeout(w.timer);
      if (m.ok === false) w.reject(new Error(m.error || 'failed')); else w.resolve(m);
    });
    this.proc.on('exit', (code) => {
      this.proc = null;
      for (const w of this.waiting.values()) { clearTimeout(w.timer); w.reject(new Error('The Windows helper stopped.')); }
      this.waiting.clear();
      if (this.stopping) return;
      this.restarts++;
      this.emit('log', `helper exited (${code}), restarting`);
      setTimeout(() => { this.start(); if (this.hookConfig) this.call('hook', this.hookConfig).catch(() => {}); }, Math.min(5000, 300 * this.restarts));
    });
  }

  call(cmd, args = {}, timeout = 15000) {
    if (!this.proc) this.start();
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error(cmd + ' timed out')); }, timeout);
      this.waiting.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n');
    });
  }

  setHook(enabled, chord) {
    this.hookConfig = { enabled, chord };
    return this.call('hook', this.hookConfig).catch(() => {});
  }

  stop() {
    this.stopping = true;
    if (this.proc) { try { this.proc.stdin.end(); this.proc.kill(); } catch {} }
  }
}

module.exports = { Native };
