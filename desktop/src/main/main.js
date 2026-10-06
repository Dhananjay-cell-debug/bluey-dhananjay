// Bluey for Windows: a blueberry who lives under your screen (and on your Android phone), points at things
// with his own big cursor, and thinks with your Claude or ChatGPT subscription (no API keys).
'use strict';

const { BrowserWindow, app, Tray, Menu, globalShortcut, ipcMain, clipboard, shell, nativeImage, dialog, screen, session: electronSession, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');

const { Settings } = require('./settings');
const { NotesStore } = require('./notes');
const { Whisper, MODELS: WHISPER_MODELS } = require('./whisper');
const { Native } = require('./native');
const { Host } = require('./host');
const { OverlayController, ReportCard, FaceDock, createPanel } = require('./windows');
const { PhoneServer } = require('./phone');
const { Bluey } = require('./bluey');
const { Learning } = require('./learning');
const locate = require('./brain/locate');
const { research } = require('./brain/research');

if (!process.env.BLUEY_QA && !app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.setAppUserModelId('app.bluey.desktop');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
// Windows reports the overlay as "occluded" (it's click-through and transparent), which would pause his animation.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

const DEV = !app.isPackaged;
// Quality checks run with their own settings and notes, never touching yours (the speech model is shared).
const REAL_USER_DATA = app.getPath('userData');
if (process.env.BLUEY_QA) {
  const qaData = path.join(process.env.BLUEY_QA_OUT || require('os').tmpdir(), 'userdata');
  fs.mkdirSync(qaData, { recursive: true });
  app.setPath('userData', qaData);
}
const ROOT = path.join(__dirname, '..', '..');
const res = (...p) => (DEV ? path.join(ROOT, ...p) : path.join(process.resourcesPath, ...p));
const PATHS = {
  native: DEV ? path.join(ROOT, 'native', 'BlueyNative.exe') : res('native', 'BlueyNative.exe'),
  whisperBin: DEV ? path.join(ROOT, 'vendor', 'whisper') : res('whisper'),
  bridge: DEV ? path.join(__dirname, 'brain', 'mcp-bridge.js') : res('bridge', 'mcp-bridge.js'),
  adb: DEV ? path.join(ROOT, 'vendor', 'adb', 'adb.exe') : res('adb', 'adb.exe'),
  apk: DEV ? path.join(ROOT, 'vendor', 'android', 'Bluey.apk') : res('android', 'Bluey.apk'),
  icon: path.join(__dirname, '..', 'assets', 'icon.png'),
  trayIcon: path.join(__dirname, '..', 'assets', 'tray.png'),
};

let usb = null;
let adbHands = null;
let dock = null;
let settings, notes, whisper, native, overlay, report, phones, host, bluey, tray, panel, learning;
const timings = [];
let brainStatus = null;
let toolServer = null;
const secret = crypto.randomBytes(24).toString('hex');
let pairRequest = null;
let codexModels = null;  // the ChatGPT plan's models, read once from Codex  // a new phone waiting for Allow
const warnings = [];

function log(...a) { if (DEV || process.env.BLUEY_DEBUG) console.log('[bluey]', ...a); }

function notesRoot() {
  if (process.env.BLUEY_QA) return path.join(app.getPath('userData'), 'Bluey Notes');
  return settings.get('notesFolder') || path.join(app.getPath('documents'), 'Bluey Notes');
}

// ───────────── Local tool server (the MCP bridge calls into this) ─────────────

function startToolServer() {
  return new Promise((resolve) => {
    toolServer = http.createServer((req, resp) => {
      if (req.headers['x-bluey-secret'] !== secret || req.method !== 'POST') { resp.writeHead(403); return resp.end(); }
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {}
        let out;
        try {
          if (req.url === '/tools/list') out = { tools: host.tools() };
          else if (req.url === '/tools/call') out = await host.run(String(body.name || '').replace(/^mcp__bluey__/, ''), body.arguments || {});
          else if (req.url === '/companion/status') out = {
            state: bluey.state,
            route: bluey.lastRoute, timings: timings.slice(-30), learning: learning.list(),
            phones: [...phones.phones.values()].filter(p => p.paired).map(p => ({ name: p.name, hands: !!p.hands, voice: !!p.voice, version: p.version || null, playback: p.playback || null })),
          };
          else if (req.url === '/companion/check') {
            if (body.action === 'wake') await bluey.wake('phone');
            else if (body.action === 'greet') await bluey.sayHi();
            else if (body.action === 'sleep') bluey.sleep();
            else if (body.action === 'ask') bluey.typed(body.text);
            else throw new Error('Unknown companion check');
            out = { state: bluey.state };
          }
          else out = { error: 'unknown' };
        } catch (e) { out = { error: e.message }; }
        resp.writeHead(200, { 'content-type': 'application/json' });
        resp.end(JSON.stringify(out));
      });
    });
    toolServer.listen(0, '127.0.0.1', () => resolve(toolServer.address().port));
  });
}

function bridgeCommand(port) {
  return () => ({
    command: process.execPath,
    args: [PATHS.bridge],
    env: { ELECTRON_RUN_AS_NODE: '1', BLUEY_PORT: String(port), BLUEY_SECRET: secret },
  });
}

// ───────────── Status for the panel, tray and phone ─────────────

function status() {
  return {
    state: bluey ? bluey.state : 'asleep',
    brain: bluey && bluey.brainName,
    brains: brainStatus,
    whisper: whisper ? { state: whisper.state, detail: whisper.detail, model: whisper.model } : null,
    phones: phones ? phones.list() : [],
    usb: usb ? usb.devices : [],
    phoneHands: (() => { const t = phones && phones.handsPhone(); return t ? { name: t.info.name, hands: !!t.info.hands, lite: !!t.info.lite } : null; })(),
    wirelessPhone: adbHands && adbHands.connected ? (adbHands.model || adbHands.serial) : null,
    usage: bluey && bluey.usage,
    route: bluey && bluey.lastRoute,
    addresses: phones ? phones.addresses() : [],
    port: phones && phones.port,
    pairRequest: pairRequest ? { name: pairRequest.name, numbers: pairRequest.numbers } : null,
    mic: bluey && bluey.micSource,
    notesRoot: notesRoot(),
    lastError: bluey && bluey.lastError,
    warnings: warnings.slice(-5),
    version: app.getVersion(),
  };
}

function pushStatus() {
  if (panel && !panel.isDestroyed()) panel.webContents.send('panel:status', status());
  if (phones && bluey) phones.broadcast({ t: 'status', ...phoneStatus() });
  if (overlay && bluey) overlay.send('overlay:model', { awake: bluey.awake, route: bluey.lastRoute });
  refreshTray();
}

function learningCommand(m) {
  if (m.action === 'toggle') settings.set('learningEnabled', !!m.enabled);
  else if (m.action === 'save') learning.put({ ...m.item, source: 'Edited by you' });
  else if (m.action === 'delete') learning.remove(m.id);
  if (m.action) {
    phones.broadcast({ t: 'learningChanged' });
    if (panel && !panel.isDestroyed()) panel.webContents.send('panel:learningChanged');
  }
  return learning.list();
}

async function refreshBrains() {
  brainStatus = await locate.status().catch(() => brainStatus);
  pushStatus();
  return brainStatus;
}

// ───────────── Tray ─────────────

function trayImage() {
  try {
    const img = nativeImage.createFromPath(PATHS.trayIcon);
    if (!img.isEmpty()) return img;
  } catch {}
  return nativeImage.createEmpty();
}

function refreshTray() {
  if (!tray) return;
  const s = settings;
  const awake = bluey && bluey.awake;
  const phoneNames = phones ? phones.list() : [];
  const radio = (label, key, value, extra) => ({ label, type: 'radio', checked: s.get(key) === value, click: () => s.set(key, value), ...extra });
  const brainLabel = (b) => {
    const st = brainStatus && brainStatus[b];
    if (!st) return '';
    if (!st.installed) return ' (not installed)';
    if (!st.loggedIn) return ' (not signed in)';
    return '';
  };
  const menu = Menu.buildFromTemplate([
    { label: phoneNames.length ? `Phone connected: ${phoneNames.join(', ')}` : pairRequest ? `${pairRequest.name} wants to pair (${pairRequest.numbers})` : 'No phone connected (works without one too)', enabled: false },
    { label: awake ? 'Go to Sleep (Follow Mode)' : 'Wake Up and Talk', accelerator: 'Ctrl+Alt+Space', click: () => bluey.toggle() },
    { label: 'Open Bluey', click: () => showPanel() },
    { label: 'Type to Bluey…', accelerator: 'Ctrl+Alt+K', click: () => showPanel('chat') },
    { type: 'separator' },
    { label: 'Let Him Use the Computer', type: 'checkbox', checked: s.get('computerControl'), click: (i) => s.set('computerControl', i.checked) },
    { label: 'Let Him Use My Phone', type: 'checkbox', checked: s.get('phoneControl'), click: (i) => s.set('phoneControl', i.checked) },
    { label: 'Stop Him', accelerator: 'Ctrl+Alt+S', click: () => host.stopActions() },
    { type: 'separator' },
    { label: 'Point Here', accelerator: 'Ctrl+Alt+P', click: pointHere },
    { label: 'Eyes Follow My Mouse', type: 'checkbox', accelerator: 'Ctrl+Alt+F', checked: s.get('followMouse'), click: toggleFollow },
    { label: 'Stop Pointing', accelerator: 'Ctrl+Alt+D', click: () => host.goHome() },
    { label: 'Talk Test', accelerator: 'Ctrl+Alt+T', click: talkTest },
    { type: 'separator' },
    { label: 'Brain', submenu: [
      radio('Automatic (Claude, else ChatGPT)', 'brain', 'auto'),
      radio('Claude subscription' + brainLabel('claude'), 'brain', 'claude'),
      radio('ChatGPT subscription (Codex)' + brainLabel('codex'), 'brain', 'codex'),
      { type: 'separator' },
      radio('Fastest replies', 'speed', 'fast'),
      radio('Balanced', 'speed', 'balanced'),
      radio('Smartest', 'speed', 'smart'),
      { type: 'separator' },
      { label: 'Check Sign-in Again', click: () => refreshBrains() },
    ] },
    { label: 'Microphone', submenu: [
      radio("Automatic (phone if it's connected)", 'micSource', 'auto'),
      radio("Phone's microphone", 'micSource', 'phone'),
      radio("This PC's microphone", 'micSource', 'pc'),
    ] },
    { label: 'Mood', submenu: ['listening', 'resting', 'thinking', 'happy'].map((m) => radio(m[0].toUpperCase() + m.slice(1), 'mood', m)) },
    { label: 'Cursor Size', submenu: [['Small', 48], ['Medium', 72], ['Large', 96], ['Huge', 120]].map(([n, v]) => radio(`${n} (${v} pt)`, 'cursorSize', v)) },
    { label: 'Phone Sits Under', submenu: [['Left', 0.2], ['Center', 0.5], ['Right', 0.8]].map(([n, v]) => radio(n, 'phonePosition', v)) },
    { label: 'Pointer Trail', submenu: [['Comet Trail', 'comet'], ['String to the Phone', 'string'], ['No Trail', 'none']].map(([n, v]) => radio(n, 'trail', v)) },
    { label: 'His Face on the Desktop (when no phone)', type: 'checkbox', checked: s.get('faceOnDesktop'), click: (i) => s.set('faceOnDesktop', i.checked) },
    { label: 'Cursor Glow', type: 'checkbox', checked: s.get('glow'), click: (i) => s.set('glow', i.checked) },
    { label: 'Show Cursor', type: 'checkbox', accelerator: 'Ctrl+Alt+H', checked: s.get('showCursor'), click: (i) => s.set('showCursor', i.checked) },
    { type: 'separator' },
    { label: 'Open Meeting Notes', click: openNotes },
    { label: 'Personality…', click: () => showPanel('settings') },
    ...(pairRequest ? [{ label: `Allow ${pairRequest.name} (${pairRequest.numbers})`, click: () => pairRequest && pairRequest.allow() }] : []),
    { label: 'Pair a Phone…', click: () => showPanel('phone') },
    { label: 'Start with Windows', type: 'checkbox', checked: s.get('launchAtLogin'), click: (i) => { s.set('launchAtLogin', i.checked); applyLoginItem(); } },
    { type: 'separator' },
    { label: 'Quit Bluey', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  const u = bluey && bluey.usage;
  const usage = u && u.fiveHour != null ? ` · ${u.plan} plan ${Math.round(u.fiveHour * 100)}% of 5-hour limit used` : '';
  tray.setToolTip(`Bluey — ${bluey ? bluey.state : 'asleep'}${phoneNames.length ? ' · phone connected' : ''}${usage}`.slice(0, 127));
}

function applyLoginItem() {
  if (!DEV) app.setLoginItemSettings({ openAtLogin: settings.get('launchAtLogin'), args: ['--hidden'] });
}

// ───────────── Actions ─────────────

function pointHere() {
  const m = overlay.mouse;
  overlay.setMode({ kind: 'pinned', x: m.x, y: m.y });
}

function toggleFollow() {
  settings.set('followMouse', !settings.get('followMouse'));
  overlay.goHome();
}

function talkTest() {
  overlay.send('overlay:talkTest', 3);
  if (dock) dock.send('dock:talk', 3);
  phones.broadcast({ t: 'talkTest', seconds: 3 });
  bluey.chirp(4);
}

function openNotes() {
  fs.mkdirSync(notesRoot(), { recursive: true });
  shell.openPath(notesRoot());
}

function showPanel(tab) {
  if (!panel || panel.isDestroyed()) {
    panel = createPanel();
    panel.once('ready-to-show', () => { panel.show(); if (tab) panel.webContents.send('panel:tab', tab); });
    panel.on('closed', () => { panel = null; });
  } else {
    if (panel.isMinimized()) panel.restore();
    panel.show();
    panel.focus();
    if (tab) panel.webContents.send('panel:tab', tab);
  }
}

/** Push to talk on this PC: tap the chord to wake/sleep, hold it to ask (like tapping and holding the phone). */
let pttTimer = null, pttAsking = false;
function onPtt(e) {
  if (e.phase === 'down') {
    clearTimeout(pttTimer);
    pttAsking = false;
    pttTimer = setTimeout(() => { pttAsking = true; bluey.beginAsk('pc'); }, 300);
  } else {
    clearTimeout(pttTimer);
    if (pttAsking) { pttAsking = false; bluey.endAsk(); } else bluey.toggle('pc');
  }
}

function registerShortcuts() {
  const keys = {
    'Ctrl+Alt+P': pointHere,
    'Ctrl+Alt+F': toggleFollow,
    'Ctrl+Alt+D': () => host.goHome(),
    'Ctrl+Alt+H': () => settings.set('showCursor', !settings.get('showCursor')),
    'Ctrl+Alt+T': talkTest,
    'Ctrl+Alt+S': () => host.stopActions(),
    'Ctrl+Alt+K': () => showPanel('chat'),
  };
  for (const [accel, fn] of Object.entries(keys)) {
    try { if (!globalShortcut.register(accel, fn)) warnings.push(`${accel} is used by another app.`); } catch {}
  }
}

// ───────────── Panel and phone commands ─────────────

function wireIpc() {
  ipcMain.handle('panel:learning', (e, m) => learningCommand(m || {}));
  ipcMain.on('overlay:voiceStatus', (e, m) => { if (e.sender === overlay.window?.webContents) bluey.speech.played(m); });
  ipcMain.handle('panel:init', () => ({ settings: settings.public(), status: status(), sessions: notes.list(),
    whisperModels: Object.fromEntries(Object.entries(WHISPER_MODELS).map(([k, v]) => [k, v.label])),
    defaultPersonality: require('./prompts').defaultPersonality }));
  ipcMain.handle('panel:sessions', () => notes.list());
  ipcMain.handle('panel:session', (e, id) => { const s = notes.get(id); if (s) { const { folder, ...rest } = s; return { ...rest, folder }; } return null; });
  ipcMain.handle('panel:delete', (e, id) => notes.delete(id));
  ipcMain.handle('panel:resume', async (e, id) => { await bluey.wake('pc', { resumeId: id }); return true; });
  ipcMain.handle('panel:copyPrompt', (e, id) => { clipboard.writeText(notes.agentPrompt(id)); return true; });
  ipcMain.handle('panel:copyText', (e, id) => { clipboard.writeText(notes.exportText(id)); return true; });
  ipcMain.handle('panel:openFolder', (e, id) => { const s = id && notes.get(id); shell.openPath(s ? s.folder : notesRoot()); return true; });
  ipcMain.handle('panel:settings', (e, patch) => { settings.update(patch || {}); return settings.public(); });
  ipcMain.handle('panel:toggle', () => bluey.toggle('pc'));
  ipcMain.handle('panel:type', (e, text) => bluey.typed(text));
  ipcMain.handle('panel:pairAnswer', (e, allow) => { if (pairRequest) (allow ? pairRequest.allow() : pairRequest.deny()); return true; });
  ipcMain.handle('panel:health', () => health());
  ipcMain.handle('panel:speakTest', () => bluey.speak("Hiya! I'm Bluey. This is how I sound. Want me to open something for you?")),
  ipcMain.handle('panel:adbPair', async (e, { pairAddress, code, connectAddress }) => {
    if (pairAddress && code) { const r = await adbHands.pair(pairAddress, code); if (!r.ok) return r; }
    if (connectAddress) return adbHands.connect(connectAddress);
    return { ok: true, message: 'Paired. Now enter the "IP address & Port" shown at the top of the Wireless debugging screen and press Connect.' };
  });
  ipcMain.handle('panel:adbLook', async () => adbHands.connected || await adbHands.refresh() ? (await adbHands.look(false)).text : 'No phone connected.');
  ipcMain.handle('panel:qr', async () => {
    const ip = phones.addresses()[0];
    if (!ip) return null;
    const url = `http://${ip}:${phones.port}/`;
    return { url, svg: await require('qrcode').toString(url, { type: 'svg', margin: 1, color: { dark: '#17151F', light: '#FFFFFF' } }) };
  });
  ipcMain.handle('panel:models', async () => {
    if (!codexModels) codexModels = await require('./brain/codex').listModels().catch(() => []);
    return { claude: require('./brain/claude').CHOICES, codex: codexModels, voices: require('./edge-tts').VOICES };
  });
  ipcMain.handle('panel:installPhone', async () => { const r = await usb.install(); pushStatus(); return r; });
  ipcMain.handle('panel:forget', (e, id) => { phones.forget(id); return settings.public(); });
  ipcMain.handle('panel:refreshBrains', () => refreshBrains());
  ipcMain.handle('panel:firewall', () => allowFirewall());
  ipcMain.handle('panel:openExternal', (e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });
  ipcMain.handle('panel:talkTest', () => talkTest());
  ipcMain.handle('panel:stop', () => host.stopActions());
  ipcMain.handle('panel:openTerminal', (e, which) => openSignIn(which));
  ipcMain.handle('panel:fix', async (e, action) => {
    if (action === 'firewall') return allowFirewall();
    if (action === 'speech') { whisper.stop(); return whisper.start().then(() => true, () => false); }
    if (action === 'native') { native.stop(); native.stopping = false; native.start(); return true; }
    return openSignIn(action);
  });
  ipcMain.on('overlay:audio', (e, buf) => bluey.pushAudio(Buffer.from(buf), 'pc'));
  ipcMain.on('overlay:micError', (e, msg) => bluey.fail("This PC's microphone isn't working: " + msg));
}

function onPhoneCommand(m, info, reply) {
  switch (m.t) {
    case 'toggle': return bluey.toggle(info);
    case 'wake': return bluey.wake(info);
    case 'sleep': return bluey.sleep();
    case 'askStart': return bluey.beginAsk(info);
    case 'askEnd': return bluey.endAsk();
    case 'type': return bluey.typed(m.text);
    case 'sayHi': return bluey.sayHi();
    case 'resume': return bluey.wake(info, { resumeId: m.id });
    case 'sessions': return reply({ t: 'sessions', list: notes.list().slice(0, 200).map(({ folder, ...s }) => s) });
    case 'session': {
      const s = notes.get(m.id);
      if (!s) return reply({ t: 'session', session: null });
      const { folder, ...rest } = s;
      return reply({ t: 'session', session: { ...rest, notesPath: folder } });
    }
    case 'deleteSession': return reply({ t: 'deleted', ok: notes.delete(m.id) });
    case 'agentPrompt': return reply({ t: 'agentPrompt', text: notes.agentPrompt(m.id) });
    case 'status': return reply({ t: 'status', ...phoneStatus() });
    case 'learning': {
      try { return reply({ t: 'learning', ...learningCommand(m) }); }
      catch (e) { return reply({ t: 'learning', ...learning.list(), error: e.message }); }
    }
    case 'stop': return host.stopActions();
    default: return undefined;
  }
}

function phoneStatus() {
  return { state: bluey.state, brain: bluey.brainName || bluey.chooseBrain(), route: bluey.lastRoute, computerControl: settings.get('computerControl'),
    whisper: whisper.state, pc: require('os').hostname() };
}

/** Opens a terminal to sign in to (or install) Claude Code or Codex. */
function openSignIn(which) {
  const cmd = {
    claude: 'claude auth login',
    codex: 'codex login',
    'install-claude': 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"',
    'install-codex': 'npm install -g @openai/codex',
  }[which] || 'claude auth login';
  execFile('cmd.exe', ['/c', 'start', '"Sign in"', 'cmd.exe', '/k', cmd], { windowsHide: false }, () => {});
}

/** Lets the phone reach this PC on private networks (asks Windows for permission once). */
function allowFirewall() {
  const exe = process.execPath.replace(/'/g, "''");
  const script = `New-NetFirewallRule -DisplayName 'Bluey (phone link)' -Direction Inbound -Program '${exe}' -Action Allow -Profile Private,Domain -ErrorAction SilentlyContinue | Out-Null`;
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', `Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile','-Command',"${script.replace(/"/g, '`"')}"`],
      { windowsHide: true }, (err) => resolve(!err));
  });
}

// ───────────── Keeping the brains current ─────────────

/**
 * New models arrive through the CLIs: Claude Code's aliases (opus, sonnet) always point at the newest, and Codex lists
 * whatever the ChatGPT plan offers. So twice a day, while he's asleep, Bluey updates both CLIs and re-reads the models.
 */
function keepBrainsCurrent() {
  const run = (tool, args) => new Promise((resolve) => {
    if (!tool) return resolve(null);
    const env = { ...process.env };
    if (tool.node) env.ELECTRON_RUN_AS_NODE = '1';
    execFile(tool.command, [...tool.prefix, ...args], { env, timeout: 5 * 60 * 1000, windowsHide: true }, (e, out, err) => resolve((out || '') + (err || '')));
  });
  const tick = async () => {
    if (bluey && bluey.awake) return;  // never in the middle of a session
    const c = await run(locate.findClaude(), ['update']);
    const x = await run(locate.findCodex(), ['update']);
    log('brain update', (c || '').split('\n').filter(Boolean).pop(), '|', (x || '').split('\n').filter(Boolean).pop());
    codexModels = await require('./brain/codex').listModels().catch(() => codexModels);
    settings.set('brainsCheckedAt', Date.now());
    await refreshBrains();
    if (bluey && !bluey.awake) bluey.restartBrain();  // the standby brain picks up any new default
  };
  const last = settings.get('brainsCheckedAt') || 0;
  setTimeout(tick, Math.max(5 * 60 * 1000, 12 * 3600 * 1000 - (Date.now() - last)));
  setInterval(tick, 12 * 3600 * 1000);
}

// ───────────── Health check ─────────────

/** Checks everything only this PC can prove, each with a fix. */
async function health() {
  const checks = [];
  const add = (id, ok, label, detail, fix) => checks.push({ id, ok, label, detail, fix: ok ? null : fix });
  const b = await refreshBrains() || {};
  for (const [key, name] of [['claude', 'Claude (Claude Code)'], ['codex', 'ChatGPT (Codex)']]) {
    const s = b[key] || {};
    if (!s.installed) add(key, false, name, 'Not installed', { label: 'Install', action: 'install-' + key });
    else if (!s.loggedIn) add(key, false, name, 'Installed, not signed in', { label: 'Sign in', action: key });
    else add(key, s.subscription !== false, name, s.subscription === false ? 'Signed in with an API key: sign in with your subscription instead' : 'Signed in with your subscription', { label: 'Sign in', action: key });
  }
  const oneBrain = ['claude', 'codex'].some((k) => b[k] && b[k].installed && b[k].loggedIn);
  checks.unshift({ id: 'brain', ok: oneBrain, label: 'A brain to think with', detail: oneBrain ? 'Ready' : 'Sign in to Claude or ChatGPT below', fix: null });
  add('speech', whisper.state === 'ready', 'Hearing (speech recognition)', whisper.state === 'ready' ? `Ready (${whisper.model})` : whisper.state === 'downloading' ? `Downloading ${whisper.detail || 0}%` : whisper.detail || whisper.state, { label: 'Retry', action: 'speech' });
  try {
    const shot = await native.call('snapshot', { maxEdge: 320, quality: 40 }, 20000);
    const locked = /LockApp/i.test(shot.app || '');
    add('screen', true, 'Seeing the screen (capture + OCR)', locked ? 'Works (screen is locked right now)' : `Read ${shot.lines.length} lines of text`, null);
    add('controls', true, 'Reading app controls (UI Automation)', `${shot.controls.length} controls in ${shot.app || 'the front app'}`, null);
  } catch (e) { add('screen', false, 'Seeing the screen', e.message, { label: 'Restart helper', action: 'native' }); }
  add('phoneLink', !!(phones && phones.port), 'Phone link', phones && phones.port ? `Listening on ${phones.addresses().join(', ') || 'this PC'}:${phones.port}` : 'Not listening', { label: 'Allow in firewall', action: 'firewall' });
  try { fs.mkdirSync(notesRoot(), { recursive: true }); fs.accessSync(notesRoot(), fs.constants.W_OK); add('notes', true, 'Notes folder', notesRoot(), null); }
  catch (e) { add('notes', false, 'Notes folder', e.message, { label: 'Open settings', action: 'settings' }); }
  const keyWarnings = warnings.filter((w) => /used by another app/.test(w));
  add('keys', keyWarnings.length === 0, 'Shortcuts', keyWarnings.length ? keyWarnings.join(' ') : 'All registered', null);
  return checks;
}

// ───────────── Startup ─────────────

app.on('second-instance', () => showPanel());

app.whenReady().then(async () => {
  settings = new Settings(path.join(app.getPath('userData'), 'settings.json'));
  learning = new Learning(path.join(app.getPath('userData'), 'learning.json'), settings);
  notes = new NotesStore(notesRoot(), { userName: settings.get('userName') });
  settings.on('change', (k) => {
    if (k === 'userName') notes.userName = settings.get('userName');
    if (k === 'notesFolder') notes.root = notesRoot();
    if (k === 'speechEngine' && whisper) { whisper.stop(); whisper.engine = settings.get('speechEngine') === 'whisper' ? 'whisper' : 'parakeet'; if (bluey && bluey.awake) whisper.start().catch(() => {}); }
    if (k === 'whisperModel' && whisper) { whisper.stop(); whisper.model = settings.get('whisperModel'); whisper.language = WHISPER_MODELS[whisper.model].language; if (bluey && bluey.awake) whisper.start().catch(() => {}); }
    if (k === 'pttChord') native.setHook(true, settings.get('pttChord'));
    if (k === 'followMouse' && host && host.queue.length === 0) overlay.goHome();
    if (panel && !panel.isDestroyed()) panel.webContents.send('panel:settings', settings.public());
    refreshTray();
  });

  // Let the overlay use the PC microphone without a prompt (it's Bluey's own page).
  electronSession.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'media' || permission === 'clipboard-sanitized-write'));
  electronSession.defaultSession.setPermissionCheckHandler((wc, permission) => permission === 'media');

  native = new Native(PATHS.native);
  native.start();
  native.on('ptt', onPtt);
  native.setHook(true, settings.get('pttChord'));

  whisper = new Whisper({ binDir: PATHS.whisperBin, modelDir: path.join(REAL_USER_DATA, 'models'), model: settings.get('whisperModel'),
    engine: settings.get('speechEngine') === 'whisper' ? 'whisper' : 'parakeet',
    asrWorker: path.join(__dirname, 'asr-worker.js').replace('app.asar', 'app.asar.unpacked'),
    sherpaPath: DEV ? path.join(ROOT, 'node_modules', 'sherpa-onnx-node') : path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'sherpa-onnx-node') });
  whisper.on('fallback', (why) => { warnings.push('Using the smaller speech model: ' + why); pushStatus(); });
  whisper.on('state', pushStatus);

  overlay = new OverlayController(settings);
  overlay.create();
  report = new ReportCard();

  const { safeStorage } = require('electron');
  const vault = safeStorage.isEncryptionAvailable() ? { seal: (t) => safeStorage.encryptString(t), unseal: (b) => safeStorage.decryptString(b) } : null;
  const identity = require('./secure').loadIdentity(path.join(app.getPath('userData'), 'identity.json'), vault);
  phones = new PhoneServer({ devices: settings.get('devices'), save: (d) => settings.set('devices', [...d]), name: require('os').hostname(), identity, apk: PATHS.apk });
  phones.on('pairRequest', (request) => {
    pairRequest = request;
    pushStatus();
    if (!request) return;
    // Same six digits on both screens: if they match, it's really your phone.
    overlay.send('overlay:bubble', { text: `Pair ${request.name}? ${request.numbers}`, life: 20 });
    if (panel && !panel.isDestroyed() && panel.isVisible()) panel.webContents.send('panel:tab', 'phone');
    log('pair request from', request.name, request.numbers);
    try { fs.writeFileSync(path.join(app.getPath('userData'), 'pair-request.txt'), `${request.name} ${request.numbers}
`); } catch {}
    if (process.env.BLUEY_QA) return;  // the QA phone answers through the panel API
    // A tiny always-on-top parent keeps the question in front of every other window.
    const top = new BrowserWindow({ width: 1, height: 1, show: false, alwaysOnTop: true, skipTaskbar: true });
    top.setAlwaysOnTop(true, 'screen-saver');
    dialog.showMessageBox(top, {
      type: 'question', title: 'Pair a phone with Bluey', buttons: ['Allow', "Don't allow"], defaultId: 0, cancelId: 1, noLink: true,
      message: `${request.name} wants to pair with Bluey.`,
      detail: `Check that your phone shows the same numbers:

${request.numbers}

Only allow it if the numbers match. A paired phone can ask Bluey to use this PC.`,
    }).then(({ response }) => { top.destroy(); if (pairRequest === request) (response === 0 ? request.allow() : request.deny()); });
  });
  phones.on('phones', () => pushStatus());
  phones.on('caps', (c) => log('phone caps:', c.name, 'can use phone =', c.hands, c.lite ? '(Lite app)' : '(Full app)', 'version', c.version, c.versionCode));
  phones.on('updateOffered', (u) => log('phone update offered:', u.name, u.from, '->', u.to));
  phones.on('updateStatus', (u) => log('phone update:', u.name, u.state, u.detail));
  phones.on('warning', (w) => { warnings.push(w); pushStatus(); });
  phones.on('audio', ({ data }) => bluey.pushAudio(data, 'phone'));
  phones.on('command', onPhoneCommand);
  phones.on('connect', (info) => {
    phones.sendTo(info, { t: 'state', state: bluey.state });
    phones.sendTo(info, { t: 'status', ...phoneStatus() });
    if (bluey.awake && bluey.micSource === 'phone') phones.sendTo(info, { t: 'mic', on: true });
  });
  phones.on('disconnect', () => {
    // The phone was the mic and it's gone: keep the session going on this PC's mic.
    if (bluey.awake && bluey.micSource === 'phone' && !phones.connected) {
      bluey.micSource = 'pc';
      overlay.send('overlay:mic', { on: true, deviceId: settings.get('pcMicDevice') || undefined });
      bluey.toast('Phone disconnected; listening on this PC instead.');
    }
    pushStatus();
  });
  await phones.start();
  const { Usb } = require('./usb');
  usb = new Usb({ adb: PATHS.adb, apk: PATHS.apk, port: phones.port || 47613 });
  usb.on('devices', pushStatus);
  if (!process.env.BLUEY_QA) usb.start();

  host = new Host({
    native, overlay, report, settings, display: () => overlay.size(),
    research: (q, context) => research(q, { context, brain: bluey.brainName || 'claude', workDir: path.join(app.getPath('userData'), 'brain', 'research'), speed: settings.get('speed') }),
  });
  let lastPanelFace = 0;
  dock = new FaceDock(settings);
  const updateDock = () => {
    // Only while he's awake (Ctrl+Alt+Space) and no phone is his face. Asleep, he stays out of the way.
    if (settings.get('faceOnDesktop') && bluey.awake && !process.env.BLUEY_QA) dock.show(); else dock.hide();
  };
  overlay.on('face', (face) => {
    phones.face(face);
    if (dock.visible) dock.send('dock:face', face);
    const now = Date.now();
    if (panel && !panel.isDestroyed() && panel.isVisible() && now - lastPanelFace > 30) { lastPanelFace = now; panel.webContents.send('panel:face', face); }
  });

  const port = await startToolServer();
  // Source (unpackaged) runs only: let the project's own QA scripts drive the live app through the same local tool server.
  if (DEV && !process.env.BLUEY_QA) { try { fs.writeFileSync(path.join(app.getPath('userData'), 'dev-control.json'), JSON.stringify({ port, secret }), { mode: 0o600 }); } catch {} }
  bluey = new Bluey({ settings, notes, whisper, host, overlay, phones, brainStatus: () => brainStatus, bridge: bridgeCommand(port),
    workDir: path.join(app.getPath('userData'), 'brain') });
  host.learning = learning;
  host.on('learningChanged', () => { phones.broadcast({ t: 'learningChanged' }); if (panel && !panel.isDestroyed()) panel.webContents.send('panel:learningChanged'); });
  const recordTiming = t => { timings.push({ ...t, at: Date.now() }); if (timings.length > 100) timings.shift(); };
  host.on('toolTiming', recordTiming);
  bluey.on('timing', recordTiming);
  phones.on('voiceStatus', m => bluey.speech.played(m));
  bluey.on('state', (st) => { pushStatus(); dock.setState(st); updateDock(); });
  const { AdbHands } = require('./adbhands');
  adbHands = new AdbHands({ adb: PATHS.adb, nativeImage });
  adbHands.on('change', pushStatus);
  // The phone app's own hands if it has them; otherwise the phone's wireless debugging (no app permission needed).
  host.phoneBridge = async (tool, args) => {
    const target = phones.handsPhone();
    if (target && target.info.hands) return phones.phoneTool(tool, args);
    if (await adbHands.refresh()) return adbHands.tool(tool, args);
    return phones.phoneTool(tool, args);
  };
  phones.on('phones', updateDock);
  settings.on('change', (k) => { if (k === 'faceOnDesktop') updateDock(); if (k === 'phonePosition') dock.place(); });
  updateDock();
  ipcMain.on('dock:toggle', () => bluey.toggle('pc'));
  ipcMain.on('dock:menu', () => {
    Menu.buildFromTemplate([
      { label: 'Put Bluey to sleep', click: () => bluey.sleep() },
      { label: 'Hide his face', click: () => { settings.set('faceOnDesktop', false); dock.hide(); } },
      { label: 'Open Bluey', click: () => showPanel() },
      { type: 'separator' },
      { label: 'Quit Bluey', click: () => app.quit() },
    ]).popup();
  });
  ipcMain.on('dock:askStart', () => bluey.beginAsk('pc'));
  ipcMain.on('dock:askEnd', () => bluey.endAsk());
  bluey.on('brain', pushStatus);
  bluey.on('usage', pushStatus);
  bluey.on('route', (r) => { log('route:', r.tier, '->', r.brain, r.model, r.effort, '(' + r.why + ')'); pushStatus(); });
  bluey.codexModels = codexModels || [];
  require('./brain/codex').listModels().then((m) => { codexModels = m; bluey.codexModels = m; }).catch(() => {});
  // Speaker labels for the notes, worked out in the background as each audio chunk finishes.
  const { Diarizer, speakerAt } = require('./diarize');
  const sherpaPath = DEV ? path.join(ROOT, 'node_modules', 'sherpa-onnx-node') : path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'sherpa-onnx-node');
  const diarizer = new Diarizer({ modelDir: path.join(REAL_USER_DATA, 'models', 'diarize'), sherpaPath, worker: path.join(__dirname, 'diarize-worker.js').replace('app.asar', 'app.asar.unpacked') });
  bluey.on('chunk', (c) => {
    if (!settings.get('speakerLabels')) return;
    diarizer.analyse(c.file).then((segments) => {
      const n = notes.labelSpeakers(c.session, c.startedAt, c.startedAt + c.seconds * 1000 + 1000, (t) => speakerAt(segments, c.startedAt, t));
      log('speaker labels', path.basename(c.file), segments.length, 'segments,', n, 'lines labelled');
    }).catch((e) => { warnings.push('Speaker labels: ' + e.message); log('diarize failed', e.message); });
  });
  bluey.on('warning', (w) => { warnings.push(w); log('warning', w); pushStatus(); });
  bluey.on('learned', (items) => log('learned:', items.map((i) => i.text).join(' | ')));
  bluey.on('log', (m) => log(m));
  bluey.on('toast', (t) => { if (panel && !panel.isDestroyed()) panel.webContents.send('panel:toast', t); });
  bluey.on('caption', (c) => { if (panel && !panel.isDestroyed()) panel.webContents.send('panel:caption', c); });
  notes.on('entry', (e) => { if (panel && !panel.isDestroyed()) panel.webContents.send('panel:entry', e); phones.broadcast({ t: 'entry', ...e }); });
  notes.on('changed', () => { if (panel && !panel.isDestroyed()) panel.webContents.send('panel:sessionsChanged'); phones.broadcast({ t: 'sessionsChanged' }); });

  tray = new Tray(trayImage());
  tray.on('click', () => showPanel());
  wireIpc();
  registerShortcuts();
  refreshTray();
  applyLoginItem();
  refreshBrains().then(() => {
    const b = brainStatus || {};
    const ready = ['claude', 'codex'].some((k) => b[k] && b[k].installed && b[k].loggedIn);
    if (!ready || !settings.get('firstRunDone')) showPanel(ready ? null : 'settings');
    settings.set('firstRunDone', true);
    if (ready) bluey.prewarm(500);
  });
  // Warm up speech recognition in the background (downloads the model the first time).
  whisper.start().catch((e) => { warnings.push('Speech recognition: ' + e.message); pushStatus(); });
  setInterval(() => overlay.raise(), 5000);
  if (!process.env.BLUEY_QA) keepBrainsCurrent();
  if (!process.argv.includes('--hidden') && DEV) log('ready');
  require('./qa').maybeRun({ app, showPanel, getPanel: () => panel, bluey, host, overlay, notes, whisper, native, phones, settings, report, status, PATHS });
});

app.on('window-all-closed', (e) => e.preventDefault());
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  try { if (bluey) bluey.sleep(); } catch {}
  try { whisper && whisper.stop(); } catch {}
  try { native && native.stop(); } catch {}
  try { phones && phones.stop(); } catch {}
  try { usb && usb.stop(); } catch {}
});
