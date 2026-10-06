// Built-in quality checks that drive the real, running app (not mocks).
// Run with BLUEY_QA=<scenario[,scenario…]> and BLUEY_QA_OUT=<folder>; results go to <folder>/qa-report.json
// along with screenshots of the overlay and panel, then the app quits.
//
// Scenarios:
//   visual    pictures of his cursor and speech bubble (pointing, near the top edge, at home), the report card
//   look      a real look at the screen: OCR lines, controls, timings
//   brain     a typed question to the real subscription brain, end to end (tools, caption, notes)
//   point     asks him to point at a word on screen and checks his cursor got there
//   voice     feeds recorded speech through the whole voice path (hold, let go, whisper, brain)
//   notes     checks the session's notes.md / session.json were written
'use strict';

const fs = require('fs');
const path = require('path');
const { BrowserWindow } = require('electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readWavPcm(file) {
  const buf = fs.readFileSync(file);
  let offset = 12;
  while (offset < buf.length - 8) {
    const id = buf.toString('ascii', offset, offset + 4), size = buf.readUInt32LE(offset + 4);
    if (id === 'data') return new Int16Array(buf.buffer.slice(buf.byteOffset + offset + 8, buf.byteOffset + offset + 8 + size));
    offset += 8 + size;
  }
  throw new Error('no data chunk');
}

/** Captures a window and composites it over dark grey (transparent pixels would otherwise look white). */
async function capture(win, file, retry = true) {
  const { nativeImage } = require('electron');
  win.webContents.invalidate();
  await sleep(350);
  const image = await win.webContents.capturePage();
  // Right after launch the compositor can hand back an empty frame; look once more before calling it blank.
  if (retry && image.toBitmap().every((v, i) => i % 4 !== 3 || v === 0)) { await sleep(700); return capture(win, file, false); }
  capture.hash[path.basename(file)] = require('crypto').createHash('md5').update(image.toBitmap()).digest('hex');
  const size = image.getSize();
  const bgra = Buffer.from(image.toBitmap());
  let visible = 0;
  for (let i = 0; i < bgra.length; i += 4) {
    const a = bgra[i + 3] / 255;
    if (a > 0) visible++;
    // Premultiplied BGRA over #1F1F24.
    bgra[i] = Math.round(bgra[i] + 0x24 * (1 - a));
    bgra[i + 1] = Math.round(bgra[i + 1] + 0x1F * (1 - a));
    bgra[i + 2] = Math.round(bgra[i + 2] + 0x1F * (1 - a));
    bgra[i + 3] = 255;
  }
  fs.writeFileSync(file, nativeImage.createFromBitmap(bgra, { width: size.width, height: size.height }).toPNG());
  console.log('[qa] captured', path.basename(file), 'visible pixels', visible);
  capture.visible[path.basename(file)] = visible;
  return file;
}

capture.visible = {};
capture.hash = {};

/** Waits for the brain's turn to finish; returns { text, ms, error, firstTextMs }. */
function waitTurn(bluey, timeout = 120000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let caption = '', firstTextMs = null;
    const onCaption = (c) => { if (c.text) { caption = c.text; if (firstTextMs == null) firstTextMs = Date.now() - t0; } };
    const onDone = (r) => finish(r.error, r.text);
    const finish = (error, text) => {
      clearTimeout(timer);
      bluey.removeListener('caption', onCaption);
      bluey.removeListener('turnDone', onDone);
      resolve({ text: text || caption, ms: Date.now() - t0, firstTextMs, error: error || null });
    };
    const timer = setTimeout(() => finish('timeout'), timeout);
    bluey.on('caption', onCaption);
    bluey.on('turnDone', onDone);
  });
}

async function run(ctx, scenarios, out) {
  const { bluey, host, overlay, notes, whisper, settings, report } = ctx;
  const results = [];
  const timings = [];
  bluey.on('timing', (t) => timings.push(t));
  if (process.env.BLUEY_QA_BRAIN) settings.data.brain = process.env.BLUEY_QA_BRAIN;  // not saved
  if (process.env.BLUEY_QA_SPEED) settings.data.speed = process.env.BLUEY_QA_SPEED;
  const record = (name, ok, details) => { results.push({ name, ok, ...details }); console.log(`[qa] ${ok ? 'PASS' : 'FAIL'} ${name}`, JSON.stringify(details).slice(0, 400)); };
  await sleep(2500);  // let the overlay and helper settle

  if (scenarios.includes('visual')) {
    const size = overlay.size();
    const thing = { x: size.width * 0.3, y: size.height * 0.55, w: 90, h: 22 };
    overlay.setMode({ kind: 'pinned', x: thing.x + thing.w / 2, y: thing.y + thing.h + 3 });
    overlay.send('overlay:speechTarget', thing);
    overlay.send('overlay:caption', "That's the prompt box, where you type to Claude. Cheeky little thing.");
    await sleep(1800);
    const a = await capture(overlay.window, path.join(out, 'overlay-pointing.png'));
    overlay.send('overlay:speechTarget', { x: size.width * 0.6, y: 20, w: 80, h: 20 });
    overlay.setMode({ kind: 'pinned', x: size.width * 0.6 + 40, y: 43 });
    overlay.send('overlay:caption', 'Near the top, so the bubble hangs underneath instead.');
    await sleep(1600);
    const b = await capture(overlay.window, path.join(out, 'overlay-top.png'));
    overlay.send('overlay:caption', null);
    overlay.send('overlay:speechTarget', null);
    overlay.setMode({ kind: 'docked' });
    await sleep(1400);
    overlay.send('overlay:caption', 'Morning! Hold the keys and ask me anything about your screen.');
    overlay.send('overlay:bubble', { text: 'Ctrl+T', life: 3 });
    await sleep(900);
    const c = await capture(overlay.window, path.join(out, 'overlay-home.png'));
    overlay.send('overlay:caption', null);
    overlay.send('overlay:click', { x: size.width * 0.5, y: size.height * 0.4 });
    overlay.setMode({ kind: 'pinned', x: size.width * 0.5, y: size.height * 0.4 });
    await sleep(1200);
    overlay.send('overlay:click', { x: size.width * 0.5, y: size.height * 0.4 });
    overlay.send('overlay:typed', 'hey');
    await sleep(160);
    const d = await capture(overlay.window, path.join(out, 'overlay-click.png'));
    report.showLoading('How tall is the Eiffel Tower?');
    await sleep(800);
    const e = await capture(report.window, path.join(out, 'report-loading.png'));
    report.show({ question: 'How tall is the Eiffel Tower?', title: 'The Eiffel Tower is 330 m tall',
      paragraphs: ['Including its antennas, the Eiffel Tower stands about 330 metres (1,083 ft) tall.', 'It was 300 m when it opened in 1889; antennas added the rest over the years.'],
      sources: [{ title: 'Official site', url: 'https://www.toureiffel.paris/en' }] });
    await sleep(700);
    const f = await capture(report.window, path.join(out, 'report-preview.png'));
    report.window.hide();
    overlay.goHome();
    const blank = Object.entries(capture.visible).filter(([, v]) => v < 500).map(([k]) => k);
    record('visual', blank.length === 0, { files: [a, b, c, d, e, f], blank });
  }

  if (scenarios.includes('panel')) {
    ctx.showPanel();
    await sleep(2500);
    const files = [];
    for (const tab of ['chat', 'sessions', 'phone', 'settings']) {
      ctx.showPanel(tab);
      await sleep(2500);
      files.push(await capture(ctx.getPanel(), path.join(out, `panel-${tab}.png`)));
    }
    const hashes = files.map((f) => capture.hash[path.basename(f)]);
    const distinct = new Set(hashes).size;
    record('panel', distinct === files.length, { files, distinctTabs: distinct });
  }

  if (scenarios.includes('look')) {
    const t0 = Date.now();
    const r = await host.look();
    const shot = host.snapshot;
    const ok = !!(shot && shot.lines.length > 0 && r.image);
    record('look', ok, { ms: Date.now() - t0, lines: shot ? shot.lines.length : 0, controls: shot ? shot.controls.length : 0,
      app: shot && shot.app, sample: r.text.split('\n').slice(0, 12) });
    if (r.image) fs.writeFileSync(path.join(out, 'look.jpg'), Buffer.from(r.image, 'base64'));
  }

  if (scenarios.includes('brain')) {
    settings.set('captions', true);
    const t0 = Date.now();
    const turnP = waitTurn(bluey);
    bluey.typed('Quick check: reply with exactly the words "blueberry online" and nothing else.');
    const turn = await turnP;
    const ok = /blueberry online/i.test(turn.text) && !turn.error;
    record('brain', ok, { brain: bluey.brainName, ms: Date.now() - t0, firstTextMs: turn.firstTextMs, reply: turn.text, error: turn.error });
  }

  if (scenarios.includes('latency')) {
    // Three short typed questions; reports how long until his first word appears.
    const firsts = [];
    for (const q of ['What app am I looking at? One short line.', "What's 17 times 23?", 'Say hi in five words.']) {
      const turnP = waitTurn(bluey);
      bluey.typed(q);
      const turn = await turnP;
      firsts.push({ q, firstTextMs: turn.firstTextMs, totalMs: turn.ms, reply: turn.text, error: turn.error });
      await sleep(500);
    }
    const ms = firsts.map((f) => f.firstTextMs || 99999).sort((a, b) => a - b);
    record('latency', firsts.every((f) => f.reply && !f.error), { brain: bluey.brainName, speed: settings.get('speed'), medianFirstTextMs: ms[1], runs: firsts });
  }

  if (scenarios.includes('point')) {
    // Opens a known word in Notepad, asks him to point at it, then checks where his cursor went.
    const word = 'PINEAPPLE';
    const tmp = path.join(out, 'point-target.txt');
    fs.writeFileSync(tmp, `\n\n\n                                        ${word}\n`);
    require('child_process').spawn('notepad.exe', [tmp], { detached: true, stdio: 'ignore' }).unref();
    await sleep(2500);
    const t0 = Date.now();
    if (!bluey.awake) { await bluey.wake(); await sleep(800); }
    const turnP = waitTurn(bluey);
    bluey.ask(`Point at the word ${word} on my screen and tell me what fruit it is.`, true);
    const turn = await turnP;
    await sleep(300);
    const shot = host.snapshot;
    let target = null;
    if (shot) for (const l of shot.lines) { const w = l.words.find((x) => x.text.toUpperCase().includes(word)) || (l.text.toUpperCase().includes(word) ? l : null); if (w) { target = w; break; } }
    const st = overlay.state || {};
    const dist = target && st.tip ? Math.hypot(st.tip.x - (target.rect.x + target.rect.w / 2), st.tip.y - (target.rect.y + target.rect.h)) : null;
    const pic = await capture(overlay.window, path.join(out, 'point-result.png'));
    const ok = dist != null && dist < 60 && /pineapple/i.test(turn.text);
    record('point', ok, { ms: Date.now() - t0, reply: turn.text, distance: dist && Math.round(dist), found: !!target, error: turn.error, pic });
    // (Leaves Notepad open: closing it could lose the user's own unsaved notes.)
  }

  if (scenarios.includes('voice')) {
    const fixture = path.join(__dirname, '..', '..', 'test', 'fixtures', 'question.wav');
    const pcm = readWavPcm(fixture);
    if (bluey.awake) bluey.sleep();
    settings.set('micSource', 'pc');
    bluey.externalAudio = true;  // the recording stands in for the mic
    await bluey.wake('pc');
    await sleep(600);
    const feed = async (samples) => {
      for (let i = 0; i < samples.length; i += 1600) { bluey.pushAudio(Buffer.from(samples.slice(i, i + 1600).buffer), 'pc'); await sleep(100); }
    };
    await feed(new Int16Array(16000));  // a second of silence
    const t0 = Date.now();
    bluey.beginAsk('pc');
    await feed(pcm);
    await feed(new Int16Array(4800));
    const heard = new Promise((resolve) => {
      const f = (e) => { if (e.entry.kind === 'asked') { notes.removeListener('entry', f); resolve(e.entry.text); } };
      notes.on('entry', f);
      setTimeout(() => resolve(null), 20000);
    });
    const turnP = waitTurn(bluey);
    bluey.endAsk();
    const asked = await heard;
    const askedMs = Date.now() - t0;
    const turn = await turnP;
    const ok = !!asked && /button/i.test(asked) && !!turn.text && !turn.error;
    bluey.externalAudio = false;
    const stage = (n) => (timings.filter((t) => t.stage === n).pop() || {}).ms;
    record('voice', ok, { transcribed: asked, releaseToTextMs: stage('transcribed'), askToFirstWordMs: stage('firstText'),
      reply: turn.text, totalMs: Date.now() - t0, error: turn.error });
    settings.set('micSource', 'auto');
  }

  if (scenarios.includes('facerate')) {
    let n = 0; const f = () => n++;
    overlay.on('face', f); await sleep(2000); overlay.removeListener('face', f);
    record('facerate', n > 60, { facesPerSecond: n / 2, phones: ctx.phones.list() });
  }

  if (scenarios.includes('phone')) {
    if (bluey.awake) { bluey.sleep(); await sleep(800); }
    // Acts exactly like the Android app: pair (matching numbers + Allow), wake, stream the mic, hold, let go.
    const { PhoneSim } = require('./phone-sim');
    const { phones } = ctx;
    const phone = new PhoneSim({ name: 'QA Phone' });
    const t0 = Date.now();
    const pcHello = await phone.connect(`ws://127.0.0.1:${phones.port}/`);
    await sleep(300);
    const request = phones.pendingRequest;
    const numbersMatch = !!request && request.numbers === pcHello.numbers;
    if (request) request.allow();
    const paired = await phone.next('paired', 5000);
    phone.clear();
    phone.send({ t: 'toggle' });  // double tap
    const micOn = await phone.next((m) => m.t === 'mic' && m.on, 8000);
    const listening = await phone.next((m) => m.t === 'state' && m.state === 'listening', 8000);
    const chirp = await phone.next('chirp', 3000);
    const face = await phone.next('face', 3000);
    const pcm = readWavPcm(path.join(__dirname, '..', '..', 'test', 'fixtures', 'question.wav'));
    const stream = async (samples) => { for (let i = 0; i < samples.length; i += 1600) { phone.sendAudio(Buffer.from(samples.slice(i, i + 1600).buffer)); await sleep(100); } };
    await stream(new Int16Array(8000));
    phone.send({ t: 'askStart' });
    const asking = await phone.next((m) => m.t === 'state' && m.state === 'asking', 3000);
    await stream(pcm);
    await stream(new Int16Array(3200));
    const released = Date.now();
    phone.send({ t: 'askEnd' });
    const heard = await phone.next((m) => m.t === 'heard' && m.asked, 20000);
    const caption = await phone.next((m) => m.t === 'caption' && m.done && m.text, 60000);
    const answerMs = Date.now() - released;
    phone.send({ t: 'sessions', rid: 7 });
    const sessions = await phone.next((m) => m.t === 'sessions' && m.rid === 7, 5000);
    phone.send({ t: 'toggle' });
    const asleep = await phone.next((m) => m.t === 'state' && m.state === 'asleep', 8000);
    const micOff = await phone.next((m) => m.t === 'mic' && m.on === false, 3000);
    phone.close();
    // A stranger who isn't allowed can't do anything.
    const stranger = new PhoneSim({ name: 'Stranger' });
    await stranger.connect(`ws://127.0.0.1:${phones.port}/`);
    stranger.send({ t: 'toggle' });
    await sleep(600);
    const strangerIgnored = bluey.state === 'asleep';
    if (phones.pendingRequest) phones.pendingRequest.deny();
    const denied = await stranger.next('pairDenied', 3000);
    stranger.close();
    const checks = { numbersMatch, paired: !!paired, micOn: !!micOn, listening: !!listening, chirp: !!chirp, face: !!face, asking: !!asking,
      heard: heard && heard.text, reply: caption && caption.text, sessions: sessions ? sessions.list.length : null, asleep: !!asleep,
      micOff: !!micOff, strangerIgnored, strangerDenied: !!denied };
    const ok = Object.values(checks).every((v) => v !== false && v !== null && v !== undefined) && /button/i.test(checks.heard || '');
    record('phone', ok, { ...checks, releaseToAnswerMs: answerMs, totalMs: Date.now() - t0 });
  }

  if (scenarios.includes('speakers')) {
    // Two different voices through a real session: the notes should say Speaker A, B, A, B.
    const pcm = readWavPcm(path.join(__dirname, '..', '..', 'test', 'fixtures', 'two-voices.wav'));
    if (bluey.awake) { bluey.sleep(); await sleep(800); }
    settings.data.micSource = 'pc';
    bluey.externalAudio = true;
    await bluey.wake('pc');
    const sessionId = notes.current.id;
    await sleep(500);
    for (let i = 0; i < pcm.length; i += 1600) { bluey.pushAudio(Buffer.from(pcm.slice(i, i + 1600).buffer), 'pc'); await sleep(100); }
    for (let i = 0; i < 20; i++) { bluey.pushAudio(Buffer.from(new Int16Array(1600).buffer), 'pc'); await sleep(100); }
    await sleep(4000);  // let the last lines transcribe
    const labelled = new Promise((resolve) => {
      const f = (id) => { const s = notes.get(id); if (id === sessionId && s && s.entries.some((e) => e.speaker)) { notes.removeListener('changed', f); resolve(s); } };
      notes.on('changed', f);
      setTimeout(() => resolve(notes.get(sessionId)), 120000);
    });
    const t0 = Date.now();
    bluey.sleep();  // closes the audio chunk, which starts the speaker analysis
    bluey.externalAudio = false;
    const s = await labelled;
    const heard = (s ? s.entries : []).filter((e) => e.kind === 'heard').map((e) => ({ speaker: e.speaker, text: e.text }));
    const letters = heard.map((h) => h.speaker).join('');
    const alternates = heard.length >= 3 && heard.every((h, i) => h.speaker && (i === 0 || h.speaker !== heard[i - 1].speaker || /bluey|hotel|old town/i.test(h.text)));
    const md = s && fs.existsSync(path.join(s.folder, 'notes.md')) ? fs.readFileSync(path.join(s.folder, 'notes.md'), 'utf8') : '';
    record('speakers', new Set(heard.map((h) => h.speaker)).size === 2 && /Speaker A/.test(md) && /Speaker B/.test(md),
      { letters, alternates, labelMs: Date.now() - t0, heard });
  }

  if (scenarios.includes('tabs')) {
    // Two windows of our own; Bluey is asked (through his real brain) to switch between them.
    const { BrowserWindow } = require('electron');
    const make = (title, color) => {
      const w = new BrowserWindow({ width: 520, height: 300, title, show: true, autoHideMenuBar: true, backgroundColor: color });
      w.loadURL('data:text/html,' + encodeURIComponent(`<title>${title}</title><body style="font:40px sans-serif;color:white">${title}</body>`));
      w.on('page-title-updated', (e) => e.preventDefault());
      return w;
    };
    const alpha = make('Bluey QA Alpha Window', '#4254D6');
    const beta = make('Bluey QA Beta Window', '#E5547A');
    await sleep(1500);
    beta.focus();
    await sleep(500);
    const direct = await ctx.native.call('switchTo', { name: 'QA Alpha', kind: 'window' });
    await sleep(500);
    const fg1 = await ctx.native.call('foreground');
    if (!bluey.awake) { await bluey.wake('pc'); await sleep(800); }
    const turnP = waitTurn(bluey);
    // Sample the front window while he works (your own apps, like a WhatsApp message, may grab focus afterwards).
    const seen = new Set();
    let watching = true;
    (async () => { while (watching) { try { seen.add((await ctx.native.call('foreground')).title); } catch {} await sleep(200); } })();
    bluey.ask('Switch to my Bluey QA Beta window please.', true);
    const turn = await turnP;
    await sleep(600);
    watching = false;
    const fg2 = { title: [...seen].find((t) => /QA Beta/.test(t || '')) || [...seen].pop() };
    const tabs = await ctx.native.call('windows');
    alpha.destroy(); beta.destroy();
    record('tabs', /Alpha/.test(fg1.title) && /Beta/.test(fg2.title),
      { direct: direct.text, afterDirect: fg1.title, reply: turn.text, afterBrain: fg2.title, windowsSeen: (tabs.windows || []).length, error: turn.error });
  }

  if (scenarios.includes('android')) {
    // The real phone app (release APK) on an emulator or a plugged-in phone, linked through `adb reverse`.
    const { execFileSync } = require('child_process');
    const adb = ctx.PATHS.adb;
    const serial = process.env.BLUEY_QA_ANDROID;
    const run = (...a) => { try { return execFileSync(adb, ['-s', serial, ...a], { encoding: 'utf8', timeout: 120000 }); } catch (e) { return String(e.stdout || '') + String(e.stderr || e.message); } };
    const shot = (name) => { try { fs.writeFileSync(path.join(out, name), execFileSync(adb, ['-s', serial, 'exec-out', 'screencap', '-p'], { timeout: 30000, maxBuffer: 64 * 1024 * 1024 })); } catch {} return name; };
    const { phones } = ctx;
    const steps = {};
    steps.reverse = run('reverse', 'tcp:47613', `tcp:${phones.port}`).trim() || 'ok';
    steps.install = run('install', '-r', '-g', ctx.PATHS.apk).trim().split('\n').pop();
    run('logcat', '-c');
    run('shell', 'am', 'start', '-n', 'app.bluey/.MainActivity');
    const size = (run('shell', 'wm', 'size').match(/(\d+)x(\d+)/) || [0, 1080, 1920]).slice(1).map(Number);
    const [W, H] = size[0] > size[1] ? size : [size[1], size[0]];  // landscape
    let request = null;
    for (let i = 0; i < 90 && !request; i++) { await sleep(1000); request = phones.pendingRequest; }
    shot('phone-1-numbers.png');
    steps.numbers = request && request.numbers;
    if (request) request.allow();
    await sleep(4000);
    steps.connected = phones.list();
    shot('phone-2-face.png');
    const tap = () => run('shell', 'input', 'tap', String(Math.round(W / 2)), String(Math.round(H * 0.7)));
    tap(); await sleep(90); tap();  // double tap: wake him
    let woke = false;
    for (let i = 0; i < 20 && !woke; i++) { await sleep(500); woke = bluey.state === 'listening'; }
    steps.wokeFromPhone = woke;
    await sleep(800);
    shot('phone-3-listening.png');
    // Press and hold, then let go (the emulator's mic is silent, so he says he didn't catch it).
    const hold = run('shell', 'input', 'swipe', String(Math.round(W / 2)), String(Math.round(H * 0.7)), String(Math.round(W / 2)), String(Math.round(H * 0.7)), '2500');
    steps.holdSeen = !!hold || true;
    await sleep(3000);
    // A typed question from the PC: his reply should reach the phone too.
    const turnP = waitTurn(bluey);
    bluey.ask('Say hello to my phone in five words.', true);
    const turn = await turnP;
    await sleep(800);
    shot('phone-4-reply.png');
    steps.reply = turn.text;
    tap(); await sleep(90); tap();  // double tap: back to sleep
    let slept = false;
    for (let i = 0; i < 20 && !slept; i++) { await sleep(500); slept = bluey.state === 'asleep'; }
    steps.sleptFromPhone = slept;
    const log = run('logcat', '-d', '-b', 'crash');
    steps.crash = /FATAL EXCEPTION|AndroidRuntime/.test(log) ? log.slice(0, 1500) : null;
    const ok = !!request && steps.connected.length > 0 && woke && slept && !steps.crash && !!turn.text;
    record('android', ok, steps);
  }

  if (scenarios.includes('phonecontrol')) {
    // A paired phone whose "hands" are on; the real brain is asked to do something on the phone.
    if (bluey.awake) { bluey.sleep(); await sleep(800); }
    settings.data.phoneControl = true;
    bluey.restartBrain();
    const { PhoneSim } = require('./phone-sim');
    const { phones } = ctx;
    const phone = new PhoneSim({ name: 'QA Redmi' });
    await phone.connect(`ws://127.0.0.1:${phones.port}/`);
    await sleep(300);
    if (phones.pendingRequest) phones.pendingRequest.allow();
    await phone.next('paired', 5000);
    phone.send({ t: 'caps', hands: true });
    let screen = 'home';
    const calls = [];
    phone.on('message', (m) => {
      if (m.t !== 'phoneCmd') return;
      calls.push({ tool: m.tool, args: m.args });
      let text = 'Done.';
      if (m.tool === 'phone_open_app' && /whatsapp/i.test(m.args.name || '')) { screen = 'whatsapp'; text = 'Opened WhatsApp.'; }
      if (m.tool === 'phone_tap' && screen === 'whatsapp' && /N3|mum/i.test(JSON.stringify(m.args))) { screen = 'chat'; text = 'Tapped "Mum".'; }
      const views = {
        home: 'Front app: MIUI Launcher\nN1 button @200,800 "WhatsApp"\nN2 button @500,800 "YouTube"',
        whatsapp: 'Front app: WhatsApp\nN1 text @500,60 "WhatsApp"\nN2 text @300,200 "Chats"\nN3 button @400,300 "Mum"\nN4 button @400,380 "Rahul"',
        chat: 'Front app: WhatsApp\nN1 text @500,60 "Mum"\nN2 text field @450,940 "Message"\nN3 button @930,940 "Send"',
      };
      phone.send({ t: 'phoneResult', prid: m.prid, text: text + '\nHere is the phone screen now:\n' + views[screen] });
    });
    if (!bluey.awake) { await bluey.wake('pc'); await sleep(800); }
    const turnP = waitTurn(bluey, 180000);
    bluey.ask("On my phone, open WhatsApp and open my chat with Mum. Don't send anything.", true);
    const turn = await turnP;
    phone.close();
    const tools = calls.map((c) => c.tool);
    record('phonecontrol', tools.includes('phone_open_app') && screen === 'chat' && !tools.includes('phone_type'),
      { brain: bluey.brainName, tools, reply: turn.text, error: turn.error, ms: turn.ms });
  }

  if (scenarios.includes('speak')) {
    // He should actually start speaking when a reply finishes.
    overlay.send('overlay:speak', { text: 'Hello, I am Bluey, and I can talk now.', volume: 0.8 });
    let speaking = false, info = null;
    for (let i = 0; i < 20 && !speaking; i++) {
      await sleep(200);
      info = await overlay.window.webContents.executeJavaScript('({ speaking: speechSynthesis.speaking || speechSynthesis.pending, voices: speechSynthesis.getVoices().length, last: window.__lastSpeech })');
      speaking = info.speaking;
    }
    overlay.send('overlay:speak', null);
    record('speak', speaking, info);
  }

  if (scenarios.includes('notes')) {
    if (bluey.awake) bluey.sleep();
    await sleep(800);
    const newest = notes.list()[0];
    const folder = newest && newest.folder;
    const md = folder && fs.existsSync(path.join(folder, 'notes.md')) ? fs.readFileSync(path.join(folder, 'notes.md'), 'utf8') : '';
    const json = folder && fs.existsSync(path.join(folder, 'session.json'));
    const audio = folder && fs.existsSync(path.join(folder, 'audio')) ? fs.readdirSync(path.join(folder, 'audio')) : [];
    record('notes', !!(md && json), { folder, mdLines: md.split('\n').length, audioFiles: audio, preview: md.slice(0, 600) });
  }

  if (bluey.awake) bluey.sleep();
  const reportFile = path.join(out, 'qa-report.json');
  fs.writeFileSync(reportFile, JSON.stringify({ when: new Date().toISOString(), results, status: ctx.status() }, null, 2));
  console.log('[qa] report', reportFile, results.every((r) => r.ok) ? 'ALL PASS' : 'SOME FAILED');
}

function maybeRun(ctx) {
  const list = process.env.BLUEY_QA;
  if (!list) return;
  const out = process.env.BLUEY_QA_OUT || path.join(ctx.app.getPath('temp'), 'bluey-qa');
  fs.mkdirSync(out, { recursive: true });
  run(ctx, list.split(','), out).catch((e) => console.log('[qa] crashed', e.stack)).finally(() => setTimeout(() => ctx.app.exit(0), 800));
}

module.exports = { maybeRun, readWavPcm };
