// Runs Bluey's tools for whichever brain is thinking: look at the screen, point (one spot after another,
// each held long enough to talk about it), research, and use the computer with his own cursor while your
// real pointer is put back where you left it. Tools run one at a time, in the order they were asked for.
'use strict';

const { EventEmitter } = require('events');
const { shell } = require('electron');
const { Snapshot } = require('./screen');
const toolDefs = require('./tools');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Shortcuts that lock, log out or open the security screen are left to the user. */
const REFUSED_KEYS = new Set(['win+l', 'ctrl+alt+delete', 'ctrl+alt+del', 'ctrl+shift+esc', 'ctrl+shift+escape', 'win+ctrl+f4']);

function normalizeKeys(keys) {
  return String(keys || '').toLowerCase().replace(/\s+/g, '')
    .replace(/command|cmd|control/g, 'ctrl').replace(/option/g, 'alt').replace(/windows|super|meta/g, 'win').replace(/escape/g, 'esc');
}

class Host extends EventEmitter {
  constructor({ native, overlay, report, settings, research, display }) {
    super();
    this.native = native;
    this.overlay = overlay;
    this.report = report;
    this.settings = settings;
    this.research = research;
    this.display = display;  // () => {width, height} of the overlay in DIPs
    this.snapshot = null;
    this.chain = Promise.resolve();
    this.stoppedUntil = 0;
    // Pointing choreography.
    this.queue = [];
    this.holdUntil = 0;
    this.homeRequested = false;
    this.speaking = false;
    this.quietSince = 0;
    this.timer = null;
  }

  tools() { return toolDefs.list(this.settings.get('computerControl'), this.settings.get('phoneControl')); }

  /** Runs a tool after any earlier ones finish. Returns MCP content. */
  run(name, args) {
    const next = this.chain.then(() => this.runNow(name, args || {})).catch((e) => ({ text: 'That went wrong: ' + e.message }));
    this.chain = next.catch(() => {});
    return next.then((r) => {
      const content = [{ type: 'text', text: r.text }];
      if (r.image) content.push({ type: 'image', data: r.image, mimeType: 'image/jpeg' });
      return { content, isError: !!r.error };
    });
  }

  async runNow(name, args) {
    this.emit('tool', name);
    if (toolDefs.phoneNames.has(name)) {
      if (!this.settings.get('phoneControl')) return { text: 'The user has turned off phone control.' };
      if (name !== 'phone_look' && name !== 'phone_apps' && Date.now() < this.stoppedUntil) return { text: "The user pressed stop. Don't do anything else until they ask again." };
      if (!this.phoneBridge) return { text: "Your phone isn't connected to Bluey right now." };
      this.overlay.send('overlay:bubble', { text: name === 'phone_look' ? '📱 looking' : '📱 ' + name.replace('phone_', '') });
      const r = await this.phoneBridge(name, args);
      return { text: r.text || 'Done.', image: r.image };
    }
    if (toolDefs.actionNames.has(name)) {
      const refusal = this.actionRefusal();
      if (refusal) return { text: refusal };
      return this.action(name, args);
    }
    switch (name) {
      case 'look_at_screen': return this.look();
      case 'point_at': {
        const id = String(args.target_id || '').trim();
        if (!this.snapshot) return { text: 'Call look_at_screen first.' };
        const t = this.snapshot.target(id);
        if (!t) return { text: `No target ${id}. Use an id from the last look_at_screen.` };
        this.point({ x: t.rect.x + t.rect.w / 2, y: t.rect.y + t.rect.h + 3 }, t.rect);
        return { text: this.queue.length > 1 ? `Queued: your cursor will point at "${t.text}" after the earlier spots.` : `Pointing at "${t.text}".` };
      }
      case 'point_at_spot': {
        if (args.x == null || args.y == null) return { text: 'Give x and y.' };
        const p = this.gridPoint(args.x, args.y);
        this.point(p, { x: p.x - 16, y: p.y - 16, w: 32, h: 32 });
        return { text: 'Pointing there.' };
      }
      case 'stop_pointing':
        this.requestHome();
        return { text: 'Your cursor will head home once you finish talking.' };
      case 'web_research': {
        const question = String(args.question || '').trim();
        if (!question) return { text: 'What should I research?' };
        this.report.showLoading(question);
        try {
          const context = this.snapshot ? this.snapshot.lines.slice(0, 40).map((l) => l.text).join(' / ') : null;
          const report = await this.research(question, context);
          this.report.show(report);
          const plain = [report.title, ...report.paragraphs].join('\n\n');
          this.emit('report', plain);
          return { text: "The full report is now in a card on the user's screen. Reply with ONE short line: the key takeaway in your own words. Don't repeat the report.\n\n" + plain };
        } catch (e) {
          this.report.showError(e.message);
          return { text: `Research failed: ${e.message}. Tell the user in a few words.` };
        }
      }
      case 'go_to_sleep':
        this.emit('sleepRequested');
        return { text: 'Going to sleep. Say a very short goodbye.' };
      default:
        return { text: `Unknown tool ${name}.` };
    }
  }

  /** Starts a look right away (when you begin to ask), so the answer doesn't wait for it. */
  prefetch() {
    const started = Date.now();
    this.prefetched = this.native.call('snapshot', { maxEdge: 1280, quality: 70 })
      .then((raw) => ({ raw, at: Date.now(), started })).catch(() => null);
    return this.prefetched;
  }

  /** The prefetched look, as a message part for the question (text + screenshot), or null. */
  async freshLook(maxAgeMs = 15000) {
    const p = this.prefetched;
    this.prefetched = null;
    const got = p && await p;
    if (!got || Date.now() - got.at > maxAgeMs) return null;
    const shot = new Snapshot(got.raw, this.display());
    this.snapshot = shot;
    return { text: this.describe(shot), image: shot.jpeg };
  }

  describe(shot) {
    let text = shot.targetList;
    const m = this.overlay.mouse;
    const mx = Math.round(Math.min(Math.max(m.x / shot.size.width, 0), 1) * 1000);
    const my = Math.round(Math.min(Math.max(m.y / shot.size.height, 0), 1) * 1000);
    text += `
The user's mouse pointer is at @${mx},${my}`;
    const under = shot.targetNear(m);
    if (under) text += `, on ${under.id} "${under.text}"`;
    text += `. When they say "this", "that" or "here", they mean what's at their mouse pointer.`;
    return text;
  }

  async look(prefix) {
    try {
      const raw = await this.native.call('snapshot', { maxEdge: 1280, quality: 70 });
      const shot = new Snapshot(raw, this.display());
      this.snapshot = shot;
      let text = shot.targetList;
      const m = this.overlay.mouse;
      const mx = Math.round(Math.min(Math.max(m.x / shot.size.width, 0), 1) * 1000);
      const my = Math.round(Math.min(Math.max(m.y / shot.size.height, 0), 1) * 1000);
      text += `\nThe user's mouse pointer is at @${mx},${my}`;
      const under = shot.targetNear(m);
      if (under) text += `, on ${under.id} "${under.text}"`;
      text += '. When they say "this", "that" or "here", they mean what\'s at their mouse pointer.';
      if (prefix) text = prefix + "\nHere's the screen now (ids have changed):\n" + text;
      return { text, image: shot.jpeg };
    } catch (e) {
      const problem = "I can't see the screen right now (" + e.message + ').';
      return { text: prefix ? prefix + ' ' + problem : problem };
    }
  }

  gridPoint(x, y) {
    if (this.snapshot) return this.snapshot.gridPoint(x, y);
    const d = this.display();
    const c = (v) => Math.min(Math.max(Number(v) || 0, 0), 1000) / 1000;
    return { x: c(x) * d.width, y: c(y) * d.height };
  }

  /** The spot an action refers to: a target id (its center) or a grid position. */
  spot(args, idKey, xKey, yKey) {
    const id = args[idKey];
    if (id && this.snapshot) {
      const t = this.snapshot.target(id);
      if (t) return { point: { x: t.rect.x + t.rect.w / 2, y: t.rect.y + t.rect.h / 2 }, name: t.text };
    }
    if (args[xKey] != null && args[yKey] != null) return { point: this.gridPoint(args[xKey], args[yKey]), name: 'that spot' };
    return null;
  }

  physical(p) {
    if (this.snapshot) return this.snapshot.toPhysical(p);
    const s = this.overlay.scale || 1;
    return { x: Math.round(p.x * s), y: Math.round(p.y * s) };
  }

  // ───────────── Using the computer ─────────────

  actionRefusal() {
    if (!this.settings.get('computerControl')) return 'The user has turned off computer control. You can still look and point.';
    if (Date.now() < this.stoppedUntil) return "The user pressed stop. Don't do anything else until they ask again.";
    return null;
  }

  async action(name, args) {
    this.takeControl();
    try {
      switch (name) {
        case 'click': {
          const t = this.spot(args, 'target_id', 'x', 'y');
          if (!t) return { text: 'Tell me what to click: a target id from look_at_screen, or x and y.' };
          const right = !!args.right, count = args.double ? 2 : 1;
          await this.fly(t.point);
          this.overlay.send('overlay:click', { x: t.point.x, y: t.point.y, right });
          await sleep(90);  // the click lands at the bottom of the squish
          const p = this.physical(t.point);
          await this.native.call('click', { x: p.x, y: p.y, button: right ? 'right' : 'left', count, restore: true });
          await sleep(420);
          const verb = right ? 'Right-clicked' : count === 2 ? 'Double-clicked' : 'Clicked';
          return this.look(`${verb} ${t.name === 'that spot' ? 'there' : `"${t.name}"`}.`);
        }
        case 'type_text': {
          const text = String(args.text || '');
          if (!text) return { text: 'Nothing to type.' };
          const field = await this.native.call('focused').catch(() => ({ found: false }));
          if (field.password) return { text: "That's a password field. Ask the user to type it themselves." };
          const d = this.display();
          if (field.found && field.w > 0) {
            const s = this.snapshot ? this.snapshot.scale : this.overlay.scale || 1;
            const r = { x: field.x / s, y: field.y / s, w: field.w / s, h: field.h / s };
            if (r.x < d.width && r.y < d.height && r.h < d.height * 0.6) await this.fly({ x: r.x + Math.min(28, r.w * 0.2), y: r.y + r.h + 2 });
            else if (this.overlay.isHome) this.overlay.setMode({ kind: 'docked' });
          } else if (this.overlay.isHome) this.overlay.setMode({ kind: 'docked' });
          // Type in little bursts so you can watch the letters float up.
          const chunks = text.match(/[\s\S]{1,3}/g) || [];
          for (const chunk of chunks) {
            if (Date.now() < this.stoppedUntil) return { text: 'Stopped by the user.' };
            this.overlay.send('overlay:typed', chunk);
            await this.native.call('type', { text: chunk, delay: 6 });
            await sleep(22);
          }
          if (args.press_enter || args.press_return) {
            await sleep(120);
            await this.native.call('keys', { keys: 'enter' });
            this.overlay.send('overlay:bubble', { text: '↵' });
            await sleep(600);
            return this.look('Typed it and pressed Enter.');
          }
          return { text: 'Typed it.' };
        }
        case 'press_keys': {
          const keys = String(args.keys || '').trim();
          if (REFUSED_KEYS.has(normalizeKeys(keys))) return { text: "I won't press that one (it locks, logs out or opens the security screen). Ask the user to do it." };
          if (this.overlay.isHome) this.overlay.setMode({ kind: 'docked' });
          let r;
          try { r = await this.native.call('keys', { keys }); } catch (e) { return { text: e.message }; }
          this.overlay.send('overlay:bubble', { text: r.label || keys });
          await sleep(420);
          return this.look(`Pressed ${keys}.`);
        }
        case 'scroll': {
          const direction = String(args.direction || 'down').toLowerCase();
          const amount = Math.min(Math.max(Number(args.amount) || 3, 1), 10);
          const d = this.display();
          const t = this.spot(args, 'target_id', 'x', 'y');
          const point = t ? t.point : { x: d.width / 2, y: d.height / 2 };
          const units = Math.round(amount * 120);
          const [dx, dy, arrow] = direction === 'up' ? [0, -units, '↑'] : direction === 'left' ? [-units, 0, '←'] : direction === 'right' ? [units, 0, '→'] : [0, units, '↓'];
          await this.fly(point);
          this.overlay.send('overlay:bubble', { text: arrow });
          const p = this.physical(point);
          await this.native.call('scroll', { x: p.x, y: p.y, dx, dy, restore: true });
          await sleep(320);
          return this.look(`Scrolled ${direction}.`);
        }
        case 'drag': {
          const from = this.spot(args, 'from_id', 'from_x', 'from_y');
          const to = this.spot(args, 'to_id', 'to_x', 'to_y');
          if (!from || !to) return { text: 'Tell me where to drag from and to (ids or x and y).' };
          const saved = await this.native.call('mouse').catch(() => null);
          await this.fly(from.point);
          this.overlay.send('overlay:press', 0.1);
          const a = this.physical(from.point);
          await this.native.call('down', { x: a.x, y: a.y });
          await sleep(120);
          this.overlay.send('overlay:dragging', true);
          this.overlay.setMode({ kind: 'pinned', x: to.point.x, y: to.point.y });
          await sleep(60);
          // The real drag follows the animated cursor, so what you see is what happens.
          const until = Date.now() + 2500;
          while (Date.now() < until) {
            const st = this.overlay.state;
            if (!st || st.timeToArrive <= 0) break;
            const p = this.physical(st.tip);
            await this.native.call('dragmove', { x: p.x, y: p.y });
            await sleep(16);
          }
          const b = this.physical(to.point);
          await this.native.call('dragmove', { x: b.x, y: b.y });
          await sleep(80);
          await this.native.call('up', { x: b.x, y: b.y });
          this.overlay.send('overlay:dragging', false);
          await sleep(60);
          if (saved) await this.native.call('warp', { x: saved.x, y: saved.y });
          await sleep(300);
          return this.look('Dragged it.');
        }
        case 'open_app': {
          const name = String(args.name || '').trim();
          if (!name) return { text: 'Which app?' };
          if (this.overlay.isHome) this.overlay.setMode({ kind: 'docked' });
          this.overlay.send('overlay:bubble', { text: 'Opening ' + name });
          const r = await this.native.call('openApp', { name }, 20000);
          await sleep(1100);
          return this.look(r.text);
        }
        case 'list_windows': {
          const [w, t] = await Promise.all([this.native.call('windows'), this.native.call('tabs', {}).catch(() => ({ tabs: [] }))]);
          const lines = ['Open windows (front first):'];
          const wins = (w.windows || []).sort((a, b) => (b.front ? 1 : 0) - (a.front ? 1 : 0));
          for (const x of wins.slice(0, 30)) lines.push(`- ${x.app}: "${x.title}"${x.front ? ' (in front)' : ''}`);
          if ((t.tabs || []).length) {
            lines.push('Tabs in the front window:');
            for (const x of t.tabs.slice(0, 60)) lines.push(`- ${x.index}. "${x.name}"${x.selected ? ' (showing)' : ''}`);
          }
          return { text: lines.join('\n') };
        }
        case 'switch_to': {
          const name = String(args.name || '').trim();
          if (!name) return { text: 'Switch to what?' };
          if (this.overlay.isHome) this.overlay.setMode({ kind: 'docked' });
          this.overlay.send('overlay:bubble', { text: '⇆ ' + name });
          const r = await this.native.call('switchTo', { name, kind: args.kind || 'any' }, 20000);
          await sleep(500);
          return this.look(r.text);
        }
        case 'open_url': {
          let url = String(args.url || '').trim();
          if (!url) return { text: 'Which website?' };
          if (!/^[a-z]+:\/\//i.test(url)) url = 'https://' + url;
          let parsed;
          try { parsed = new URL(url); } catch { return { text: "That doesn't look like a web address." }; }
          if (!['http:', 'https:'].includes(parsed.protocol)) return { text: 'I only open http and https links.' };
          if (this.overlay.isHome) this.overlay.setMode({ kind: 'docked' });
          this.overlay.send('overlay:bubble', { text: parsed.hostname.replace(/^www\./, '') });
          await shell.openExternal(parsed.toString());
          await sleep(1500);
          return this.look(`Opened ${parsed.hostname}.`);
        }
        default:
          return { text: `Unknown action ${name}.` };
      }
    } finally {
      this.afterAction();
    }
  }

  /** The stop hotkey: refuse any further actions for a moment and bring the cursor home. */
  stopActions() {
    this.stoppedUntil = Date.now() + 6000;
    this.queue = [];
    this.overlay.send('overlay:dragging', false);
    this.goHome();
    this.overlay.send('overlay:bubble', { text: 'Stopped', life: 1.6 });
  }

  /** Actions take over the cursor: any queued pointing is dropped. */
  takeControl() {
    this.queue = [];
    this.holdUntil = 0;
    this.homeRequested = false;
    this.overlay.send('overlay:speechTarget', null);
  }

  afterAction() {
    this.holdUntil = Date.now() + 1500;
    if (!this.speaking) this.quietSince = Date.now();
    this.startChoreography();
  }

  /** Flies the cursor to a spot and waits until it has landed. */
  async fly(point) {
    this.overlay.setMode({ kind: 'pinned', x: point.x, y: point.y });
    await sleep(70);  // the next frame plans the trip
    const until = Date.now() + 1800;
    while (Date.now() < until) {
      const st = this.overlay.state;
      if (st && st.timeToArrive <= 0.02 && Math.hypot(st.tip.x - point.x, st.tip.y - point.y) < 4) break;
      await sleep(16);
    }
    await sleep(40);
  }

  // ───────────── Pointing choreography ─────────────
  // He often points at several things at once. Each spot gets its own flight and a hold long enough
  // to talk about it, and the cursor only goes home once he's finished talking.

  point(spot, thing) {
    this.queue.push({ spot, thing });
    this.homeRequested = false;
    this.startChoreography();
  }

  requestHome() {
    this.homeRequested = true;
    this.startChoreography();
  }

  startChoreography() {
    if (this.timer) return;
    this.timer = setInterval(() => this.choreograph(), 1000 / 30);
    this.choreograph();
  }

  choreograph() {
    const now = Date.now();
    if (now >= this.holdUntil && this.queue.length) {
      const { spot, thing } = this.queue.shift();
      this.overlay.send('overlay:speechTarget', thing);
      if (!this.speaking) this.quietSince = now;  // give him time to start talking about it
      this.overlay.setMode({ kind: 'pinned', x: spot.x, y: spot.y });
      this.holdUntil = now + 1000 + 2200;  // flight time plus a comfortable hold
      return;
    }
    if (this.queue.length || now < this.holdUntil) return;
    if (this.overlay.isHomeMode) { this.stopChoreography(); return; }
    // Go home once he's done talking: soon after he says so, or after a longer quiet spell.
    const quietFor = this.speaking ? 0 : now - this.quietSince;
    if ((this.homeRequested && quietFor > 1200) || quietFor > 5000) this.goHome();
  }

  goHome() {
    this.overlay.goHome();
    this.overlay.send('overlay:speechTarget', null);
    this.homeRequested = false;
    this.stopChoreography();
  }

  stopChoreography() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Called when he starts or stops "talking" (his speech bubble is up). */
  setSpeaking(on) {
    if (this.speaking && !on) this.quietSince = Date.now();
    this.speaking = on;
  }

  /** Back to follow mode: forget any pointing. */
  reset() {
    this.queue = [];
    this.stopChoreography();
    this.overlay.goHome();
    this.overlay.send('overlay:speechTarget', null);
  }
}

module.exports = { Host, normalizeKeys, REFUSED_KEYS };
