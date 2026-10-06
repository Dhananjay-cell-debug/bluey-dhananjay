// User choices, kept between launches in the app's data folder.
'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const DEFAULTS = {
  brain: 'auto',            // auto | claude | codex
  speed: 'balanced',        // fast | balanced | smart
  claudeModel: '',          // empty = from "speed" (sonnet); or fable, opus, sonnet, haiku, or a full model name
  claudeEffort: '',         // empty = from "speed"; or low, medium, high, xhigh, max
  codexModel: '',           // empty = the ChatGPT plan's default
  codexEffort: '',          // empty = from "speed"; or one the chosen model supports
  personality: '',          // empty = the built-in British blueberry
  userName: '',
  computerControl: true,
  phoneControl: true,       // let him use the paired Android phone too (the phone must allow it once)
  followMouse: true,
  cursorSize: 72,
  glow: false,
  showCursor: true,
  trail: 'comet',           // comet | string | none
  mood: 'listening',
  phonePosition: 0.5,       // where the phone sits under the screen: 0 left … 1 right
  micSource: 'auto',        // auto (phone if connected, else this PC) | phone | pc
  pcMicDevice: '',
  whisperModel: 'base.en',
  keepAudio: true,
  speakerLabels: true,      // Speaker A / B in the notes (worked out on this PC)
  pttChord: 'ctrl+alt+space',
  chirpVolume: 0.7,
  captions: true,
  speakReplies: true,       // read his replies out loud (Windows voices, on this PC); the bubble still shows
  speakVoice: '',           // empty = a British English voice if there is one
  faceOnDesktop: true,      // his face at the bottom of the screen when no phone is connected
  autoLook: true,           // send a fresh look at the screen with every question (faster answers)
  notesFolder: '',          // empty = Documents/Bluey Notes
  devices: [],              // paired phones
  launchAtLogin: false,
  firstRunDone: false,
  brainsCheckedAt: 0,
};

class Settings extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
    this.data = { ...DEFAULTS };
    try { Object.assign(this.data, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch {}
  }

  get(key) { return this.data[key]; }

  set(key, value) {
    if (this.data[key] === value) return;
    this.data[key] = value;
    this.save();
    this.emit('change', key, value);
  }

  update(patch) {
    const changed = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in DEFAULTS) || JSON.stringify(this.data[k]) === JSON.stringify(v)) continue;
      this.data[k] = v;
      changed.push(k);
    }
    if (!changed.length) return;
    this.save();
    for (const k of changed) this.emit('change', k, this.data[k]);
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch {}
  }

  /** What the renderers may see (no keys, just short ids). */
  public() {
    const { devices, ...rest } = this.data;
    return { ...rest, devices: (devices || []).filter((d) => d.pub).map((d) => ({ name: d.name, added: d.added, id: d.pub.slice(0, 16) })) };
  }
}

module.exports = { Settings, DEFAULTS };
