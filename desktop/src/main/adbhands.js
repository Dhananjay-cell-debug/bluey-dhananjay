// Bluey's hands on the phone through Android's own wireless debugging (adb over Wi-Fi). No app permission needed on
// the phone: pair once with the code from Developer options → Wireless debugging, and Bluey can look at the screen
// (text, controls, screenshot) and tap, type, scroll, press buttons and open apps and links, only when you ask.
'use strict';

const { execFile } = require('child_process');
const { EventEmitter } = require('events');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Well-known apps (the phone's own labels vary); anything else is found by searching installed package names. */
const APPS = {
  whatsapp: 'com.whatsapp', 'whatsapp business': 'com.whatsapp.w4b', youtube: 'com.google.android.youtube', instagram: 'com.instagram.android',
  chrome: 'com.android.chrome', gmail: 'com.google.android.gm', maps: 'com.google.android.apps.maps', 'google maps': 'com.google.android.apps.maps',
  telegram: 'org.telegram.messenger', spotify: 'com.spotify.music', facebook: 'com.facebook.katana', messenger: 'com.facebook.orca',
  snapchat: 'com.snapchat.android', twitter: 'com.twitter.android', x: 'com.twitter.android', 'play store': 'com.android.vending',
  photos: 'com.google.android.apps.photos', gpay: 'com.google.android.apps.nbu.paisa.user', phonepe: 'com.phonepe.app', paytm: 'net.one97.paytm',
  amazon: 'in.amazon.mShop.android.shopping', flipkart: 'com.flipkart.android', zomato: 'com.application.zomato', swiggy: 'in.swiggy.android',
  settings: 'com.android.settings', camera: 'com.android.camera', calculator: 'com.miui.calculator', gallery: 'com.miui.gallery',
  clock: 'com.android.deskclock', contacts: 'com.android.contacts', phone: 'com.android.dialer', messages: 'com.google.android.apps.messaging',
};

const KEYS = { back: 4, home: 3, recents: 187, power: 26, volume_up: 24, volume_down: 25, enter: 66 };

/** Reads the nodes out of a `uiautomator dump` XML: text, descriptions, bounds, whether it's tappable or a field. */
function parseDump(xml) {
  const nodes = [];
  const re = /<node\b([^>]*?)\/?>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attr = (name) => { const a = new RegExp('\\b' + name + '="([^"]*)"').exec(m[1]); return a ? decode(a[1]) : ''; };
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attr('bounds'));
    if (!b) continue;
    const [x1, y1, x2, y2] = b.slice(1).map(Number);
    if (x2 - x1 < 3 || y2 - y1 < 3) continue;
    const text = attr('text').trim(), desc = attr('content-desc').trim();
    const cls = attr('class');
    const editable = /EditText/.test(cls);
    const password = attr('password') === 'true';
    const clickable = attr('clickable') === 'true' || attr('long-clickable') === 'true';
    const checkable = attr('checkable') === 'true';
    const label = text || desc || (attr('hint') || '').trim();
    if (!label && !editable) continue;
    nodes.push({ label: password ? 'password field' : label.replace(/\s+/g, ' ').slice(0, 80), kind: editable ? 'text field' : checkable ? (attr('checked') === 'true' ? 'switch (on)' : 'switch (off)') : clickable ? 'button' : 'text',
      x1, y1, x2, y2, pkg: attr('package'), password });
  }
  return nodes;
}

function decode(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#10;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

class AdbHands extends EventEmitter {
  constructor({ adb, nativeImage }) {
    super();
    this.adb = adb;
    this.nativeImage = nativeImage;
    this.serial = null;
    this.targets = new Map();
    this.size = { width: 1080, height: 2400 };
  }

  run(args, { timeout = 20000, binary = false, input } = {}) {
    return new Promise((resolve) => {
      const child = execFile(this.adb, args, { timeout, windowsHide: true, encoding: binary ? 'buffer' : 'utf8', maxBuffer: 64 * 1024 * 1024 },
        (error, stdout, stderr) => resolve({ ok: !error, out: stdout, err: String(stderr || '') + (error ? ' ' + error.message : '') }));
      if (input) child.stdin.end(input);
    });
  }

  sh(...args) { return this.run(['-s', this.serial, 'shell', ...args]); }

  /** `adb pair ip:port code` (the pairing port and code shown under "Pair device with pairing code"). */
  async pair(hostPort, code) {
    const r = await this.run(['pair', hostPort.trim(), String(code).trim()], { timeout: 30000 });
    const text = (r.out + r.err).trim();
    return { ok: /Successfully paired/i.test(text), message: /Successfully paired/i.test(text) ? 'Paired.' : 'Pairing failed: ' + text.split('\n').pop() };
  }

  /** `adb connect ip:port` (the main port shown on the Wireless debugging screen, different from the pairing port). */
  async connect(hostPort) {
    const r = await this.run(['connect', hostPort.trim()], { timeout: 20000 });
    const text = (r.out + r.err).trim();
    if (!/connected to/i.test(text) || /cannot|failed|refused/i.test(text)) return { ok: false, message: 'Could not connect: ' + text.split('\n').pop() };
    this.serial = hostPort.trim();
    await this.refresh();
    this.emit('change');
    return { ok: true, message: 'Connected to ' + (this.model || 'your phone') + '.' };
  }

  /** Finds an already-connected device (USB or an earlier wireless connection). */
  async refresh() {
    const r = await this.run(['devices', '-l'], { timeout: 8000 });
    const lines = String(r.out || '').split('\n').slice(1).map((l) => l.trim()).filter(Boolean)
      .map((l) => ({ serial: l.split(/\s+/)[0], state: l.split(/\s+/)[1], model: ((/model:(\S+)/.exec(l) || [])[1] || '').replace(/_/g, ' ') }));
    const ready = lines.find((d) => d.state === 'device' && (d.serial === this.serial || !this.serial)) || lines.find((d) => d.state === 'device');
    const was = this.serial;
    this.serial = ready ? ready.serial : null;
    this.model = ready ? ready.model : null;
    this.unauthorized = lines.some((d) => d.state === 'unauthorized');
    if (this.serial) {
      const w = await this.sh('wm', 'size');
      const s = /(\d+)x(\d+)/.exec(String(w.out));
      if (s) this.size = { width: Number(s[1]), height: Number(s[2]) };
    }
    if (was !== this.serial) this.emit('change');
    return !!this.serial;
  }

  get connected() { return !!this.serial; }

  grid(n) { return `@${Math.round((n.x1 + n.x2) / 2 / this.size.width * 1000)},${Math.round((n.y1 + n.y2) / 2 / this.size.height * 1000)}`; }

  async screenshot() {
    const r = await this.run(['-s', this.serial, 'exec-out', 'screencap', '-p'], { binary: true, timeout: 20000 });
    if (!r.ok || !r.out || !r.out.length) return null;
    try {
      let img = this.nativeImage.createFromBuffer(r.out);
      const { width } = img.getSize();
      if (width > 720) img = img.resize({ width: 720, quality: 'good' });
      return img.toJPEG(70).toString('base64');
    } catch { return null; }
  }

  async look(withImage = true) {
    const dump = await this.sh('uiautomator', 'dump', '/dev/tty');
    let xml = String(dump.out || '');
    const start = xml.indexOf('<?xml');
    xml = start >= 0 ? xml.slice(start) : '';
    if (!xml) {  // some phones can't dump to the terminal
      await this.sh('uiautomator', 'dump', '/sdcard/bluey.xml');
      xml = String((await this.sh('cat', '/sdcard/bluey.xml')).out || '');
    }
    const nodes = parseDump(xml).slice(0, 220);
    this.targets = new Map(nodes.map((n, i) => ['N' + (i + 1), n]));
    const front = (await this.sh('dumpsys', 'window', 'windows')).out;
    const app = (/mCurrentFocus=.*?\s([\w.]+)\//.exec(String(front)) || [])[1] || (nodes[0] && nodes[0].pkg) || '?';
    const lines = [`Phone: ${this.model || 'Android'}, screen ${this.size.width}x${this.size.height}. Front app: ${app}`,
      "On the phone's screen (N ids, @x,y on a 0-1000 grid of the phone screen):"];
    if (!nodes.length) lines.push('(nothing readable; it may be a game, video or secure screen)');
    for (const [id, n] of this.targets) lines.push(`${id} ${n.kind} ${this.grid(n)} "${n.label}"`);
    const out = { text: lines.join('\n') };
    if (withImage) { const img = await this.screenshot(); if (img) out.image = img; }
    return out;
  }

  point(args) {
    const t = this.targets.get(String(args.target_id || '').toUpperCase());
    if (t) return { x: Math.round((t.x1 + t.x2) / 2), y: Math.round((t.y1 + t.y2) / 2), target: t };
    if (args.x != null && args.y != null) {
      const c = (v) => Math.min(Math.max(Number(v) || 0, 0), 1000) / 1000;
      return { x: Math.round(c(args.x) * this.size.width), y: Math.round(c(args.y) * this.size.height) };
    }
    return null;
  }

  async findPackage(name) {
    const key = String(name || '').trim().toLowerCase();
    if (APPS[key]) return APPS[key];
    const list = String((await this.sh('pm', 'list', 'packages')).out || '').split('\n').map((l) => l.replace('package:', '').trim()).filter(Boolean);
    const squashed = key.replace(/[^a-z0-9]/g, '');
    return list.filter((p) => p.toLowerCase().replace(/[^a-z0-9]/g, '').includes(squashed)).sort((a, b) => a.length - b.length)[0] || null;
  }

  async act(name, args) {
    switch (name) {
      case 'phone_tap': {
        const p = this.point(args);
        if (!p) return 'Tell me what to tap: an N id from phone_look, or x and y.';
        if (args.long) await this.sh('input', 'swipe', String(p.x), String(p.y), String(p.x), String(p.y), '700');
        else await this.sh('input', 'tap', String(p.x), String(p.y));
        return (args.long ? 'Long-pressed' : 'Tapped') + (p.target ? ` "${p.target.label}".` : ' there.');
      }
      case 'phone_type': {
        const text = String(args.text || '');
        const t = this.targets.get(String(args.target_id || '').toUpperCase());
        if (t && t.password) return "That's a password field. Ask the user to type it themselves.";
        if (t) { const p = this.point(args); await this.sh('input', 'tap', String(p.x), String(p.y)); await sleep(300); }
        if (args.replace !== false) { await this.sh('input', 'keycombination', '113', '29'); await this.sh('input', 'keyevent', '67'); }  // Ctrl+A, delete
        // `input text` handles ASCII only; spaces are %s. Other characters are typed one at a time through the clipboard-free path.
        const ascii = text.replace(/[^\x20-\x7E]/g, '?');
        for (const chunk of ascii.match(/[\s\S]{1,40}/g) || []) {
          await this.sh('input', 'text', chunk.replace(/ /g, '%s').replace(/([\\'"&|<>();`$])/g, '\\$1'));
        }
        if (/[^\x20-\x7E]/.test(text)) return 'Typed it, but letters outside plain English (like Hindi) can\'t be typed this way; they became "?". Use the phone app version for those.';
        if (args.press_enter) await this.sh('input', 'keyevent', '66');
        return 'Typed it.';
      }
      case 'phone_scroll': {
        const { width: w, height: h } = this.size;
        const cx = Math.round(w / 2), cy = Math.round(h / 2), dy = Math.round(h * 0.3), dx = Math.round(w * 0.3);
        const d = { down: [cx, cy + dy, cx, cy - dy], up: [cx, cy - dy, cx, cy + dy], left: [cx - dx, cy, cx + dx, cy], right: [cx + dx, cy, cx - dx, cy] }[args.direction || 'down'];
        await this.sh('input', 'swipe', ...d.map(String), '350');
        return 'Scrolled ' + (args.direction || 'down') + '.';
      }
      case 'phone_key': {
        const code = KEYS[args.key];
        if (args.key === 'notifications') { await this.sh('cmd', 'statusbar', 'expand-notifications'); return 'Opened notifications.'; }
        if (args.key === 'quick_settings') { await this.sh('cmd', 'statusbar', 'expand-settings'); return 'Opened quick settings.'; }
        if (!code) return 'Keys I can press: back, home, recents, notifications, quick_settings.';
        await this.sh('input', 'keyevent', String(code));
        return 'Pressed ' + args.key + '.';
      }
      case 'phone_open_app': {
        const pkg = await this.findPackage(args.name);
        if (!pkg) return `I couldn't find an app called "${args.name}" on the phone.`;
        const r = await this.sh('monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1');
        return /No activities found|Error/i.test(String(r.out) + r.err) ? `Couldn't open ${args.name}.` : `Opened ${args.name}.`;
      }
      case 'phone_open_url': {
        let url = String(args.url || '').trim();
        if (!url) return 'Which link?';
        if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url;
        if (!/^(https?|tel|geo|mailto|whatsapp):/i.test(url)) return 'I only open web, phone, map, mail and WhatsApp links.';
        await this.sh('am', 'start', '-a', 'android.intent.action.VIEW', '-d', `'${url.replace(/'/g, '%27')}'`);
        return 'Opened ' + url + '.';
      }
      case 'phone_apps': {
        const list = String((await this.sh('pm', 'list', 'packages', '-3')).out || '').split('\n').map((l) => l.replace('package:', '').trim()).filter(Boolean);
        return 'Apps on the phone (package names): ' + list.join(', ');
      }
      case 'phone_bluey':
        await this.sh('monkey', '-p', 'app.bluey', '-c', 'android.intent.category.LAUNCHER', '1');
        return 'Back on his face.';
      default:
        return 'Unknown phone action ' + name + '.';
    }
  }

  /** The same contract as the phone app's own hands: look, or act and then show the screen. */
  async tool(name, args = {}) {
    if (!(await this.refresh())) return { text: this.unauthorized ? 'The phone is asking "Allow USB debugging?". Tap Allow on the phone.' : "The phone isn't connected for wireless control. Connect it in Bluey → Phone." };
    try {
      if (name === 'phone_look') return await this.look(true);
      if (name === 'phone_apps') return { text: await this.act(name, args) };
      const text = await this.act(name, args);
      if (name === 'phone_bluey') return { text };
      await sleep(name === 'phone_open_app' || name === 'phone_open_url' ? 1600 : 700);
      const look = await this.look(true);
      return { text: text + "\nHere's the phone's screen now (ids have changed):\n" + look.text, image: look.image };
    } catch (e) {
      return { text: "That didn't work on the phone: " + e.message };
    }
  }
}

module.exports = { AdbHands, parseDump, APPS };
