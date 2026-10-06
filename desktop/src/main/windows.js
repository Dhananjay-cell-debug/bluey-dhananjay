// The windows: the click-through overlay where his cursor lives, the research report card, and the
// Bluey panel (sessions, chat, settings, pairing).
'use strict';

const path = require('path');
const { BrowserWindow, screen, ipcMain } = require('electron');
const { EventEmitter } = require('events');

const RENDERER = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, 'preload.js');

/** The transparent overlay over the primary screen, and everything the main process tells it. */
class OverlayController extends EventEmitter {
  constructor(settings) {
    super();
    this.settings = settings;
    this.window = null;
    this.state = null;
    this.mouse = { x: 0, y: 0 };
    this.mode = { kind: 'following' };
    this.scale = 1;
    this.ready = false;
    this.queued = [];
  }

  get idleMode() { return this.settings.get('followMouse') ? { kind: 'following' } : { kind: 'docked' }; }
  get isHome() { return this.mode.kind !== 'pinned'; }
  get isHomeMode() { return this.mode.kind === this.idleMode.kind; }

  create() {
    const display = screen.getPrimaryDisplay();
    this.display = display;
    this.scale = display.scaleFactor;
    const b = display.bounds;
    const win = new BrowserWindow({
      x: b.x, y: b.y, width: b.width, height: b.height,
      transparent: true, frame: false, resizable: false, movable: false, focusable: false, skipTaskbar: true,
      hasShadow: false, show: false, alwaysOnTop: true, fullscreenable: false, backgroundColor: '#00000000',
      webPreferences: { preload: PRELOAD, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false,
        autoplayPolicy: 'no-user-gesture-required' },  // so he may speak without anyone clicking first
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true);
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // Keep his cursor and bubbles out of his own screenshots (and screen shares).
    win.setContentProtection(true);
    win.loadFile(path.join(RENDERER, 'overlay', 'index.html'), { search: process.env.BLUEY_DIAG ? 'diag' : '' });
    win.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 'warning' || process.env.BLUEY_DEBUG) console.log('[overlay]', e.message, e.sourceId ? `${path.basename(e.sourceId)}:${e.lineNumber}` : ''); });
    win.webContents.on('render-process-gone', (e, d) => console.log('[overlay] renderer gone', d.reason));
    win.once('ready-to-show', () => win.showInactive());
    this.window = win;

    ipcMain.on('overlay:state', (e, s) => {
      if (e.sender !== win.webContents) return;
      this.state = s;
      this.emit('face', s.face);
    });
    ipcMain.on('overlay:ready', (e) => {
      if (e.sender !== win.webContents) return;
      this.ready = true;
      this.pushSettings();
      this.send('overlay:mode', this.mode);
      for (const [c, d] of this.queued) win.webContents.send(c, d);
      this.queued = [];
    });

    // Follow the real mouse at display rate.
    this.mouseTimer = setInterval(() => {
      if (!this.window || this.window.isDestroyed()) return;
      const p = screen.getCursorScreenPoint();
      const bounds = this.window.getBounds();
      this.mouse = { x: p.x - bounds.x, y: p.y - bounds.y };
      if (this.ready) this.window.webContents.send('overlay:mouse', this.mouse);
    }, 1000 / 60);

    const refit = () => {
      const d = screen.getPrimaryDisplay();
      this.display = d;
      this.scale = d.scaleFactor;
      if (this.window && !this.window.isDestroyed()) this.window.setBounds(d.bounds);
    };
    screen.on('display-metrics-changed', refit);
    screen.on('display-added', refit);
    screen.on('display-removed', refit);
    this.settings.on('change', () => this.pushSettings());
    this.goHome();
  }

  size() {
    const b = this.window && !this.window.isDestroyed() ? this.window.getBounds() : this.display.bounds;
    return { width: b.width, height: b.height };
  }

  pushSettings() {
    const s = this.settings;
    this.send('overlay:settings', { cursorSize: s.get('cursorSize'), phonePosition: s.get('phonePosition'), glow: s.get('glow'),
      showCursor: s.get('showCursor'), trail: s.get('trail'), mood: s.get('mood') });
  }

  send(channel, data) {
    if (!this.window || this.window.isDestroyed()) return;
    if (!this.ready) { this.queued.push([channel, data]); return; }
    this.window.webContents.send(channel, data);
  }

  setMode(mode) { this.mode = mode; this.send('overlay:mode', mode); }
  goHome() { this.setMode(this.idleMode); }

  /** Keeps the overlay above everything (some full-screen apps push it down). */
  raise() {
    if (this.window && !this.window.isDestroyed()) { this.window.setAlwaysOnTop(true, 'screen-saver'); this.window.moveTop(); }
  }
}

/** The research report card in the top-right corner. Click to expand; it stays until closed. */
class ReportCard {
  constructor() { this.window = null; this.model = null; this.expanded = false; }

  ensure() {
    if (this.window && !this.window.isDestroyed()) return;
    this.window = new BrowserWindow({
      width: 420, height: 160, frame: false, transparent: true, resizable: false, skipTaskbar: true, show: false,
      alwaysOnTop: true, hasShadow: false, focusable: true, backgroundColor: '#00000000', fullscreenable: false,
      webPreferences: { preload: PRELOAD, contextIsolation: true },
    });
    this.window.setAlwaysOnTop(true, 'screen-saver', 1);
    this.window.setContentProtection(true);
    this.window.loadFile(path.join(RENDERER, 'report', 'index.html'));
    this.window.webContents.on('did-finish-load', () => this.render());
    ipcMain.removeAllListeners('report:toggle');
    ipcMain.removeAllListeners('report:close');
    ipcMain.removeAllListeners('report:size');
    ipcMain.on('report:toggle', () => { this.expanded = !this.expanded; this.render(); });
    ipcMain.on('report:close', () => { if (this.window && !this.window.isDestroyed()) this.window.hide(); });
    ipcMain.on('report:size', (e, h) => this.layout(h));
  }

  showLoading(question) { this.model = { question, report: null, error: null }; this.expanded = false; this.open(); }
  show(report) { this.model = { ...(this.model || {}), report, error: null }; this.open(); }
  showError(error) { this.model = { ...(this.model || {}), error }; this.open(); }

  open() {
    this.ensure();
    this.render();
    if (!this.window.isVisible()) this.window.showInactive();
  }

  render() {
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send('report:model', { ...this.model, expanded: this.expanded });
  }

  /** Sits in the top-right corner of the main screen, out of the way of what he points at. */
  layout(contentHeight) {
    if (!this.window || this.window.isDestroyed()) return;
    const area = screen.getPrimaryDisplay().workArea;
    const width = this.expanded ? 540 : 420;
    const height = Math.min(Math.round(area.height * 0.75), Math.max(120, Math.ceil(contentHeight) + 8));
    this.window.setBounds({ x: area.x + area.width - width - 24, y: area.y + 24, width, height });
  }
}

/** His face, docked at the bottom of the screen above where the phone would sit (shown when no phone is connected). */
class FaceDock {
  constructor(settings) { this.settings = settings; this.window = null; this.state = 'asleep'; }

  bounds() {
    const area = screen.getPrimaryDisplay().workArea;
    const width = Math.round(Math.min(300, area.width * 0.16)), height = Math.round(width * 390 / 844);
    const x = Math.round(area.x + area.width * this.settings.get('phonePosition') - width / 2);
    return { x: Math.min(Math.max(x, area.x), area.x + area.width - width), y: area.y + area.height - height, width, height };
  }

  show() {
    if (!this.window || this.window.isDestroyed()) {
      this.window = new BrowserWindow({ ...this.bounds(), frame: false, transparent: true, resizable: false, skipTaskbar: true,
        alwaysOnTop: true, hasShadow: false, show: false, focusable: false, fullscreenable: false, backgroundColor: '#00000000',
        webPreferences: { preload: PRELOAD, contextIsolation: true, backgroundThrottling: false } });
      this.window.setAlwaysOnTop(true, 'screen-saver');
      this.window.setContentProtection(true);
      this.window.loadFile(path.join(RENDERER, 'dock', 'index.html'));
      this.window.webContents.on('did-finish-load', () => this.send('dock:state', this.state));
      this.window.once('ready-to-show', () => this.window.showInactive());
    } else if (!this.window.isVisible()) {
      this.window.setBounds(this.bounds());
      this.window.showInactive();
    }
  }

  hide() { if (this.window && !this.window.isDestroyed()) this.window.hide(); }
  get visible() { return !!(this.window && !this.window.isDestroyed() && this.window.isVisible()); }
  place() { if (this.visible) this.window.setBounds(this.bounds()); }
  send(c, d) { if (this.window && !this.window.isDestroyed()) this.window.webContents.send(c, d); }
  setState(s) { this.state = s; this.send('dock:state', s); }
}

/** The Bluey panel: sessions and transcripts, a chat box, settings and pairing. */
function createPanel() {
  const win = new BrowserWindow({
    width: 1080, height: 720, minWidth: 820, minHeight: 560, show: false, title: 'Bluey', backgroundColor: '#000000',
    autoHideMenuBar: true, icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: { preload: PRELOAD, contextIsolation: true },
  });
  win.loadFile(path.join(RENDERER, 'panel', 'index.html'));
  return win;
}

module.exports = { OverlayController, ReportCard, FaceDock, createPanel };
