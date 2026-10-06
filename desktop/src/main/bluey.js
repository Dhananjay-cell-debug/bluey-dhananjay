// The one source of truth for what Bluey is doing. Phones and the desktop only send intents (wake, hold,
// let go, type) and show what this says, so his face, cursor, bubble and notes always agree.
//
// asleep ──wake──▶ waking ──▶ listening ──hold──▶ asking ──let go──▶ thinking ──text──▶ speaking ──▶ listening
//    ▲                                                                                        │
//    └───────────────────────────────── sleep (double tap, hotkey, "bye") ◀───────────────────┘
'use strict';

const { EventEmitter } = require('events');
const path = require('path');
const { AudioSession } = require('./audio');
const { ClaudeBrain } = require('./brain/claude');
const { CodexBrain } = require('./brain/codex');
const prompts = require('./prompts');
const router = require('./router');
const edgeTts = require('./edge-tts');

const MOOD_FOR_STATE = { asleep: null, waking: 'happy', listening: null, asking: 'listening', thinking: 'thinking', speaking: 'talking' };

class Bluey extends EventEmitter {
  constructor({ settings, notes, whisper, host, overlay, phones, brainStatus, bridge, workDir }) {
    super();
    Object.assign(this, { settings, notes, whisper, host, overlay, phones, brainStatus, bridge, workDir });
    this.state = 'asleep';
    this.brain = null;
    this.brainName = null;
    this.audio = null;
    this.micSource = null;     // 'phone' | 'pc'
    this.micPhone = null;      // which phone streams
    this.holding = null;       // who is holding: 'phone' | 'pc' | 'typed'
    this.overheard = [];
    this.needsContext = false;
    this.caption = '';
    this.captionTimer = null;
    this.sleepAfterReply = false;
    this.speechId = 0;
    this.chirpedThisTurn = false;
    this.lastError = null;

    host.on('sleepRequested', () => { this.sleepAfterReply = true; });
    host.on('report', (text) => this.notes.add('report', text));
    settings.on('change', (key) => {
      if (['personality', 'computerControl', 'phoneControl', 'brain', 'speed', 'codexModel', 'codexEffort', 'claudeModel', 'claudeEffort', 'userName'].includes(key)) this.restartBrain();
    });
  }

  setState(state) {
    if (state === this.state) return;
    this.state = state;
    this.overlay.send('overlay:brain', { awake: state !== 'asleep', mood: MOOD_FOR_STATE[state] });
    this.phones.broadcast({ t: 'state', state });
    this.emit('state', state);
  }

  get awake() { return this.state !== 'asleep'; }

  // ───────────── Wake and sleep ─────────────

  toggle(from) { return this.awake ? this.sleep() : this.wake(from); }

  async wake(from) {
    if (this.awake) return;
    this.lastError = null;
    this.setState('waking');
    this.sleepAfterReply = false;
    this.overheard = [];
    // Which microphone: the phone's (if one is here and allowed) or this PC's.
    const pref = this.settings.get('micSource');
    const phoneHere = this.phones.connected;
    this.micSource = pref === 'pc' || (pref === 'auto' && !phoneHere) || (pref === 'phone' && !phoneHere) ? 'pc' : 'phone';
    if (pref === 'phone' && !phoneHere) this.toast("Your phone isn't connected, so I'm using this PC's microphone.");
    const session = this.notes.start({ source: this.micSource === 'phone' ? (from && from.name) || this.phones.list()[0] || 'phone' : 'this PC', brain: null });
    this.audio = new AudioSession({ audioFolder: this.settings.get('keepAudio') ? this.notes.audioFolder : null });
    this.audio.on('utterance', (u) => this.onUtterance(u));
    this.audio.on('warning', (w) => this.emit('warning', w));
    const sessionId = session.id;
    this.audio.on('chunk', (c) => this.emit('chunk', { ...c, session: sessionId }));
    this.startMic(from);
    this.whisper.start().catch((e) => this.toast('Speech recognition: ' + e.message));
    try {
      this.startBrain();
    } catch (e) {
      this.fail(e.message);
      return this.sleep();
    }
    this.emit('session', session.id);
    await new Promise((r) => setTimeout(r, 450));
    if (this.state !== 'waking') return;
    this.chirp(2);
    this.setState(this.holding ? 'asking' : 'listening');
  }

  sleep() {
    if (!this.awake) return;
    this.brainOverride = null;  // next session tries your chosen brain again
    this.holding = null;
    this.stopMic();
    if (this.audio) { this.audio.finish(); this.audio = null; }
    this.notes.end();
    this.stopBrain();
    this.clearCaption();
    this.host.reset();
    this.sleepAfterReply = false;
    this.setState('asleep');
    this.prewarm();
  }

  /**
   * Starts a fresh brain process in the background so the next session's first answer is quick.
   * An idle process makes no requests, so this uses none of your plan's usage.
   */
  prewarm(delay = 1500) {
    clearTimeout(this.prewarmTimer);
    this.prewarmTimer = setTimeout(() => {
      if (this.brain || this.awake) return;
      const s = this.brainStatus();
      if (!s) return;
      try { this.startBrain(); } catch {}
    }, delay);
  }

  startMic(from) {
    if (this.externalAudio) return;  // tests feed recorded audio instead
    if (this.micSource === 'phone') {
      this.micPhone = from && from.name ? from : null;
      this.phones.broadcast({ t: 'mic', on: true });
    } else {
      this.overlay.send('overlay:mic', { on: true, deviceId: this.settings.get('pcMicDevice') || undefined });
    }
  }

  stopMic() {
    this.phones.broadcast({ t: 'mic', on: false });
    this.overlay.send('overlay:mic', { on: false });
    this.micSource = null;
  }

  /** PCM from the phone (binary frames) or this PC (the overlay's mic capture). */
  pushAudio(data, from) {
    if (!this.audio || !this.awake) return;
    if (this.micSource === 'phone' && from !== 'phone') return;
    if (this.micSource === 'pc' && from !== 'pc') return;
    this.audio.push(data);
  }

  // ───────────── Hold to ask ─────────────

  /** You pressed and held (phone screen or the push-to-talk key): what you say now is the question. */
  beginAsk(from) {
    this.holding = from || 'phone';
    this.clearCaption();
    if (this.brain && this.brain.busy) { this.brain.interrupt(); this.host.reset(); }
    if (!this.awake) { this.wake(typeof from === 'object' ? from : null); }
    if (this.audio) this.audio.beginAsk();
    if (this.settings.get('autoLook')) this.host.prefetch();
    if (this.state === 'listening' || this.state === 'speaking' || this.state === 'thinking') this.setState('asking');
  }

  /** You let go: he answers using everything he's heard as context. */
  async endAsk() {
    if (!this.holding) return;
    this.holding = null;
    if (!this.audio) return;
    // If he was still waking up, the audio is buffered all the same.
    this.setState('thinking');
    const released = Date.now();
    const clip = await this.audio.endAsk();
    if (!clip || clip.seconds < 0.3 || clip.level < 0.003) return this.didntCatch();
    let text = '';
    try {
      text = await this.whisper.transcribe(clip.audio, { urgent: true });
      this.timing = { released, transcribed: Date.now(), seconds: clip.seconds };
      this.emit('timing', { stage: 'transcribed', ms: Date.now() - released, audioSeconds: clip.seconds });
    } catch (e) {
      this.toast('Speech recognition failed: ' + e.message);
      return this.backToListening();
    }
    if (!text) return this.didntCatch();
    this.phones.broadcast({ t: 'heard', text, asked: true });
    this.ask(text, false);
  }

  didntCatch() {
    this.flash("Didn't catch that. Hold, talk, then let go.");
    this.backToListening();
  }

  /** A typed question (from the panel or the phone). */
  typed(text) {
    text = String(text || '').trim();
    if (!text) return;
    if (this.settings.get('autoLook')) this.host.prefetch();
    if (!this.awake) {
      this.wake().then(() => this.ask(text, true));
      return;
    }
    this.ask(text, true);
  }

  async ask(question, typed) {
    if (!this.awake) return;
    this.notes.add('asked', question);
    this.setState('thinking');
    // A fresh look at the screen goes with the question, so "what's this?" needs no extra round trip.
    const look = this.settings.get('autoLook') ? await this.host.freshLook() : null;
    let message = prompts.questionMessage({ overheard: this.overheard, question, typed, look: look && look.text });
    this.lastAsk = { question, typed, image: look && look.image, message };
    this.overheard = [];
    if (this.needsContext) {
      const context = this.notes.recentText();
      if (context) message = "(Context: what was said earlier in this session, from my notes. Don't reply to this part.)\n" + context + '\n\n' + message;
      this.needsContext = false;
    }
    try {
      if (!this.brain) this.startBrain();
      this.chirpedThisTurn = false;
      this.askedAt = Date.now();
      this.route(question, typed);
      this.brain.ask(message, look && look.image ? [{ mime: 'image/jpeg', base64: look.image }] : []);
    } catch (e) {
      this.fail(e.message);
      this.backToListening();
    }
  }

  async onUtterance(u) {
    try {
      const text = await this.whisper.transcribe(u.audio);
      if (!text || !this.awake) return;
      const time = new Date(u.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      this.overheard.push({ time, text });
      if (this.overheard.length > 80) this.overheard.shift();
      this.notes.add('heard', text, { time: u.at });
      this.phones.broadcast({ t: 'heard', text, asked: false });
    } catch (e) {
      this.emit('warning', 'Transcription: ' + e.message);
    }
  }

  // ───────────── The brain ─────────────

  chooseBrain() {
    const pref = this.settings.get('brain');
    const s = this.brainStatus() || {};
    const ok = (b) => s[b] && s[b].installed && s[b].loggedIn !== false;
    if (this.brainOverride && ok(this.brainOverride)) return this.brainOverride;
    if (pref === 'claude' || pref === 'codex') return pref;
    if (ok('claude')) return 'claude';
    if (ok('codex')) return 'codex';
    return 'claude';
  }

  startBrain() {
    if (this.brain) return;
    const name = this.chooseBrain();
    const status = (this.brainStatus() || {})[name] || {};
    if (status.installed === false) {
      throw new Error(name === 'claude' ? "Claude Code isn't installed on this PC." : "Codex isn't installed on this PC.");
    }
    if (status.loggedIn === false) {
      throw new Error(name === 'claude' ? "Claude isn't signed in. Open a terminal and run: claude auth login" : "Codex isn't signed in. Open a terminal and run: codex login");
    }
    const options = {
      instructions: prompts.instructions({ personality: this.settings.get('personality'), computerControl: this.settings.get('computerControl'),
        phoneControl: this.settings.get('phoneControl'),
        userName: this.settings.get('userName') }),
      toolNames: this.host.tools().map((t) => t.name),
      bridge: this.bridge(),
      workDir: path.join(this.workDir, name),
      speed: this.settings.get('speed'),
      model: (name === 'codex' ? this.settings.get('codexModel') : this.settings.get('claudeModel')) || undefined,
      effort: (name === 'codex' ? this.settings.get('codexEffort') : this.settings.get('claudeEffort')) || undefined,
    };
    const brain = name === 'codex' ? new CodexBrain(options) : new ClaudeBrain(options);
    this.brain = brain;
    this.brainName = name;
    brain.on('turnStart', () => { if (this.state !== 'asking') this.setState('thinking'); this.host.setSpeaking(false); });
    brain.on('toolStart', () => { if (this.state !== 'speaking' && this.state !== 'asking') this.setState('thinking'); });
    brain.on('text', (text) => this.onBrainText(text));
    brain.on('reply', (text) => this.notes.add('reply', text));
    brain.on('turnEnd', (r) => this.onTurnEnd(r));
    brain.on('error', (message) => this.fail(message));
    brain.on('usage', (u) => { this.usage = u; this.emit('usage', u); });
    brain.on('ready', (info) => this.emit('brain', { name, ready: true, model: info && info.model }));
    brain.on('exit', ({ expected }) => {
      if (this.brain === brain) { this.brain = null; this.needsContext = true; }
      if (!expected && this.awake) this.emit('warning', `The ${name} brain stopped; it will restart on your next question.`);
      if (!expected && !this.awake) this.prewarm(10000);
      this.emit('brain', { name, ready: false });
    });
    brain.start();
    this.emit('brain', { name, ready: false, starting: true });
  }

  /** Chooses how hard to think about this question (see router.js) and tells the brain. */
  route(question, typed) {
    if (!this.settings.get('autoRoute') || !this.brain || !this.brain.configure) { this.lastRoute = null; return; }
    const c = router.classify(question, { typed });
    const pick = this.brainName === 'codex'
      ? { model: this.settings.get('codexModel'), effort: this.settings.get('codexEffort') }
      : { model: this.settings.get('claudeModel'), effort: this.settings.get('claudeEffort') };
    const plan = router.plan(c.tier, this.brainName, pick, this.codexModels || [], c.max);
    this.brain.configure(plan);
    this.lastRoute = { tier: c.tier, why: c.why, ...plan, brain: this.brainName };
    this.emit('route', this.lastRoute);
  }

  stopBrain() {
    if (!this.brain) return;
    const b = this.brain;
    this.brain = null;
    b.removeAllListeners();
    b.stop();
    this.needsContext = false;
  }

  /** Personality, tools or brain changed: start a fresh brain that remembers this session from the notes. */
  restartBrain() {
    if (!this.brain) return;
    this.stopBrain();
    if (this.awake) {
      this.needsContext = true;
      try { this.startBrain(); } catch (e) { this.fail(e.message); }
    } else {
      this.prewarm();
    }
  }

  onBrainText(text) {
    const clean = text.trim();
    if (!clean) return;
    if (!this.chirpedThisTurn) {
      this.chirpedThisTurn = true;
      this.emit('timing', { stage: 'firstText', ms: Date.now() - (this.askedAt || Date.now()) });
      this.chirp(Math.min(Math.max(clean.split(/\s+/).length, 3), 5));
    }
    if (this.state !== 'asking') this.setState('speaking');
    this.host.setSpeaking(true);
    this.showCaption(clean, false);
  }

  onTurnEnd({ text, error, interrupted, ms }) {
    if (interrupted) return;
    // One plan out of usage: switch to the other subscription and ask again, so you still get your answer.
    if (error && /usage limit|out of usage|usage credits/i.test(error) && this.lastAsk && !this.lastAsk.retried) {
      const other = this.brainName === 'claude' ? 'codex' : 'claude';
      const s = (this.brainStatus() || {})[other];
      if (s && s.installed && s.loggedIn) {
        const retry = { ...this.lastAsk, retried: true };
        this.brainOverride = other;
        this.stopBrain();
        this.needsContext = true;
        this.toast(`${this.brainName === 'claude' ? 'Claude' : 'ChatGPT'} plan is out of usage for now; using ${other === 'claude' ? 'Claude' : 'ChatGPT'} instead.`);
        try {
          this.startBrain();
          this.lastAsk = retry;
          this.chirpedThisTurn = false;
          this.askedAt = Date.now();
          const context = this.notes.recentText();
          const msg = (context ? "(Context: what was said earlier in this session, from my notes. Don't reply to this part.)\n" + context + '\n\n' : '') + retry.message;
          this.needsContext = false;
          this.brain.ask(msg, retry.image ? [{ mime: 'image/jpeg', base64: retry.image }] : []);
          return;
        } catch (e) { /* fall through to the error */ }
      }
    }
    this.emit('turnDone', { text, error, ms });
    if (error) {
      this.fail(error);
    } else if (text) {
      this.showCaption(text, true);
    } else {
      this.host.setSpeaking(false);
    }
    if (this.sleepAfterReply) {
      setTimeout(() => this.sleep(), 2600);
      return;
    }
    this.backToListening();
  }

  backToListening() {
    if (!this.awake) return;
    this.setState(this.holding ? 'asking' : 'listening');
  }

  // ───────────── Captions, chirps and messages ─────────────

  /** His reply: a speech bubble by his cursor (or above the phone), kept up long enough to read. */
  showCaption(text, done) {
    clearTimeout(this.captionTimer);
    this.caption = text;
    if (this.settings.get('captions')) this.overlay.send('overlay:caption', text);
    if (done && this.settings.get('speakReplies')) this.speak(text);
    this.phones.broadcast({ t: 'caption', text, done });
    this.emit('caption', { text, done });
    if (done) {
      const words = text.split(/\s+/).length;
      const readTime = Math.min(Math.max(2.8, 1.2 + words * 0.32), 12) + 3;
      this.captionTimer = setTimeout(() => {
        this.host.setSpeaking(false);
        this.clearCaption();
      }, readTime * 1000);
    }
  }

  /** Reads a reply aloud: a natural neural voice if we can reach it, otherwise this PC's own voice. */
  async speak(text) {
    const mine = ++this.speechId;
    const volume = this.settings.get('chirpVolume');
    const windows = () => this.overlay.send('overlay:speak', { text, voice: this.settings.get('speakVoice'), volume });
    if (this.settings.get('speakEngine') !== 'neural') return windows();
    const voice = /[\u0900-\u097F]/.test(text) ? 'hi-IN-SwaraNeural' : this.settings.get('speakNeuralVoice');
    try {
      const t0 = Date.now();
      const mp3 = await edgeTts.synth(text.replace(/[*_`#]/g, ''), { voice });
      if (mine !== this.speechId) return;  // he was interrupted or went to sleep meanwhile
      this.overlay.send('overlay:playAudio', { base64: mp3.toString('base64'), volume: Math.max(0.3, Math.min(1, volume + 0.2)) });
      this.emit('spoke', { engine: 'neural', voice, ms: Date.now() - t0 });
    } catch (e) {
      if (mine !== this.speechId) return;
      this.emit('warning', 'Neural voice unavailable (' + e.message + '); using the Windows voice.');
      windows();
      this.emit('spoke', { engine: 'windows', error: e.message });
    }
  }

  clearCaption() {
    this.speechId = (this.speechId || 0) + 1;
    this.overlay.send('overlay:playAudio', null);
    this.overlay.send('overlay:speak', null);  // stop talking
    clearTimeout(this.captionTimer);
    this.caption = '';
    this.overlay.send('overlay:caption', null);
    this.phones.broadcast({ t: 'caption', text: '', done: true });
  }

  /** A short status line in his bubble that tidies itself away. */
  flash(text, seconds = 3.5) {
    this.showCaption(text, false);
    clearTimeout(this.captionTimer);
    this.captionTimer = setTimeout(() => this.clearCaption(), seconds * 1000);
  }

  chirp(syllables) {
    const phoneHere = this.phones.connected;
    if (phoneHere) this.phones.broadcast({ t: 'chirp', syllables });
    else this.overlay.send('overlay:chirp', { syllables, volume: this.settings.get('chirpVolume') });
  }

  toast(text) {
    this.phones.broadcast({ t: 'toast', text });
    this.emit('toast', text);
  }

  fail(message) {
    this.lastError = message;
    this.flash(message, 7);
    this.toast(message);
    this.emit('warning', message);
  }

  /** A quick hi, for checking the chirp volume (or to wake him). */
  sayHi() {
    if (!this.awake) return this.wake();
    this.chirp(3);
    this.flash('Hiya!', 2.5);
  }
}

module.exports = { Bluey, MOOD_FOR_STATE };
