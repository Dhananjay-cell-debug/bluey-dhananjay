// The USB cable option. When an Android phone with USB debugging is plugged in, Bluey runs
// `adb reverse tcp:47613 tcp:<port>` so the phone app reaches this PC over the cable, even when the Wi-Fi
// blocks devices from seeing each other. It can also install the phone app over the cable.
'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const { EventEmitter } = require('events');

class Usb extends EventEmitter {
  constructor({ adb, apk, port }) {
    super();
    this.adb = adb;
    this.apk = apk;
    this.port = port;
    this.devices = [];      // [{serial, model, state}]
    this.reversed = new Set();
  }

  get available() { return fs.existsSync(this.adb); }

  run(args, timeout = 15000) {
    return new Promise((resolve) => {
      execFile(this.adb, args, { timeout, windowsHide: true }, (error, stdout, stderr) =>
        resolve({ ok: !error, out: String(stdout || ''), err: String(stderr || '') + (error ? ' ' + error.message : '') }));
    });
  }

  start() {
    if (!this.available) return;
    const tick = async () => {
      const r = await this.run(['devices', '-l'], 8000);
      const devices = r.out.split('\n').slice(1).map((l) => l.trim()).filter(Boolean).map((l) => {
        const [serial, state] = l.split(/\s+/);
        const model = (l.match(/model:(\S+)/) || [])[1] || serial;
        return { serial, state, model: model.replace(/_/g, ' ') };
      });
      const changed = JSON.stringify(devices) !== JSON.stringify(this.devices);
      this.devices = devices;
      for (const d of devices) {
        if (d.state !== 'device' || this.reversed.has(d.serial)) continue;
        const rr = await this.run(['-s', d.serial, 'reverse', 'tcp:47613', `tcp:${this.port}`]);
        if (rr.ok) this.reversed.add(d.serial);
      }
      for (const s of [...this.reversed]) if (!devices.find((d) => d.serial === s && d.state === 'device')) this.reversed.delete(s);
      if (changed) this.emit('devices', this.devices);
    };
    tick();
    this.timer = setInterval(tick, 4000);
  }

  /** Installs (or updates) the phone app on the plugged-in phone and opens it. */
  async install() {
    const d = this.devices.find((x) => x.state === 'device');
    if (!d) {
      const unauthorized = this.devices.find((x) => x.state === 'unauthorized');
      return { ok: false, message: unauthorized
        ? 'Your phone is asking "Allow USB debugging?". Tap Allow on the phone, then try again.'
        : 'No phone found. Turn on USB debugging (and on Xiaomi phones, "Install via USB") and plug the phone in.' };
    }
    if (!fs.existsSync(this.apk)) return { ok: false, message: 'The phone app file is missing from this install.' };
    this.emit('installing', d);
    const r = await this.run(['-s', d.serial, 'install', '-r', '-g', this.apk], 180000);
    if (!r.ok || !/Success/.test(r.out)) {
      const why = (r.out + r.err).trim().split('\n').pop();
      const hint = /INSTALL_FAILED_USER_RESTRICTED|USER_RESTRICTED/.test(r.out + r.err)
        ? ' On Xiaomi/Redmi phones, turn on "Install via USB" in Developer options and tap Install on the phone when asked.' : '';
      return { ok: false, message: `Couldn't install: ${why}.${hint}` };
    }
    await this.run(['-s', d.serial, 'shell', 'am', 'start', '-n', 'app.bluey/.MainActivity']);
    return { ok: true, message: `Installed Bluey on ${d.model}.`, model: d.model };
  }

  stop() { clearInterval(this.timer); }
}

module.exports = { Usb };
