// The Bluey panel: his live face, start/end, the live conversation and chat box, past sessions,
// phone pairing and settings.
'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const api = window.bluey;
let settings = {}, status = {}, sessions = [], openSession = null, defaultPersonality = '';

// ───────────── His face ─────────────

const { FaceAnimator, draw, mini } = window.BlueyFace;
const animator = new FaceAnimator();
const faceCanvas = $('face');
const faceCtx = faceCanvas.getContext('2d');
let talkUntil = 0;
function drawFace() {
  const dpr = window.devicePixelRatio || 1;
  const w = faceCanvas.clientWidth, h = faceCanvas.clientHeight;
  if (faceCanvas.width !== Math.round(w * dpr)) { faceCanvas.width = Math.round(w * dpr); faceCanvas.height = Math.round(h * dpr); }
  const now = performance.now() / 1000;
  animator.localTalk = () => (now < talkUntil ? 0.5 + 0.5 * Math.sin(now * 19) * Math.sin(now * 7.3) : 0);
  faceCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw(faceCtx, animator.step(now), w, h);
  requestAnimationFrame(drawFace);
}
requestAnimationFrame(drawFace);
api.on('panel:face', (f) => animator.receive(f, performance.now() / 1000));

function drawMini(canvas) {
  const c = canvas.getContext('2d');
  c.clearRect(0, 0, canvas.width, canvas.height);
  mini(c, 2, 2, canvas.width - 4, canvas.height - 4);
}
drawMini($('mini'));

const LOOK = {
  asleep: { label: 'Following your mouse', mood: null },
  waking: { label: 'Waking up', mood: 'happy' },
  listening: { label: 'Listening · hold to ask', mood: null },
  asking: { label: "I'm all ears", mood: 'listening' },
  thinking: { label: 'Thinking', mood: 'thinking' },
  speaking: { label: 'Replying', mood: 'talking' },
};

function applyState(state) {
  const look = LOOK[state] || LOOK.asleep;
  animator.awake = state !== 'asleep';
  animator.localMood = look.mood;
  $('mode').textContent = look.label;
  document.querySelector('.face-wrap').className = 'face-wrap ' + state;
  const asleep = state === 'asleep';
  $('toggle').textContent = asleep ? 'Start session' : 'End session';
  $('toggle').classList.toggle('end', !asleep);
  $('hint').textContent = asleep
    ? 'He listens the whole session. Hold to ask something, let go and he answers.'
    : 'Session running. Hold to ask; everything said is saved to your notes.';
}

// ───────────── Status ─────────────

async function runHealth() {
  const box = $('health');
  $('runHealth').textContent = 'Checking…';
  box.innerHTML = '<div class="small">Checking…</div>';
  const checks = await api.invoke('panel:health');
  $('runHealth').textContent = 'Run again';
  box.innerHTML = checks.map((c) => `<div class="check-row"><span class="mark ${c.ok ? 'ok' : 'bad'}">${c.ok ? '✓' : '!'}</span><b>${esc(c.label)}</b>
    <span class="d">${esc(c.detail)}</span>${c.fix ? `<button class="ghost" data-fix="${esc(c.fix.action)}">${esc(c.fix.label)}</button>` : ''}</div>`).join('');
  box.querySelectorAll('[data-fix]').forEach((b) => { b.onclick = async () => { b.textContent = '…'; await api.invoke('panel:fix', b.dataset.fix); setTimeout(runHealth, 1500); }; });
}
$('runHealth').onclick = runHealth;

function brainSummary() {
  const b = status.brains || {};
  const name = status.brain || (settings.brain === 'codex' ? 'codex' : settings.brain === 'claude' ? 'claude' : (b.claude && b.claude.loggedIn ? 'claude' : 'codex'));
  const label = name === 'codex' ? 'ChatGPT (Codex)' : 'Claude';
  const w = status.whisper || {};
  const ears = w.state === 'ready' ? 'ears ready' : w.state === 'downloading' ? `downloading ears ${w.detail || 0}%` : w.state === 'error' ? 'ears: problem' : 'ears warming up';
  const u = status.usage;
  const plan = u && u.fiveHour != null ? ` · ${Math.round(u.fiveHour * 100)}% of 5-hour limit used` : '';
  return `${label} subscription · ${ears}${plan}`;
}

function renderStatus() {
  const phones = status.phones || [];
  $('linkDot').classList.toggle('on', phones.length > 0);
  $('linkText').textContent = phones.length ? phones.join(', ') : 'No phone (works without one)';
  $('brainline').textContent = brainSummary();
  renderPhoneSetup();
  $('addr').textContent = (status.addresses || []).map((a) => `${a}:${status.port}`).join(' or ') || 'this PC\'s address';
  $('connected').textContent = phones.length ? phones.join(', ') : 'None right now.';
  applyState(status.state);
  renderBrains();
  renderBanner();
  const w = status.whisper || {};
  $('whisperState').textContent = w.state === 'downloading' ? `Downloading the speech model… ${w.detail || 0}%` :
    w.state === 'error' ? 'Speech recognition problem: ' + (w.detail || '') : w.state === 'ready' ? 'Speech recognition runs on this PC (private, offline).' : 'Speech recognition is starting…';
}

function renderBrains() {
  const b = status.brains || {};
  const row = (key, label) => {
    const s = b[key] || {};
    let state, action = '';
    if (!s.installed) { state = 'Not installed'; action = `<button class="ghost" data-signin="install-${key}">Install</button>`; }
    else if (!s.loggedIn) { state = 'Not signed in'; action = `<button class="ghost" data-signin="${key}">Sign in</button>`; }
    else state = (s.subscription === false ? 'Signed in with an API key (not a subscription)' : 'Signed in with your subscription') + (s.detail ? ` · ${esc(s.detail)}` : '');
    return `<div class="brain"><span class="dot ${s.installed && s.loggedIn ? 'on' : ''}"></span><b>${label}</b><span class="grow">${state}</span>${action}</div>`;
  };
  $('brains').innerHTML = row('claude', 'Claude') + row('codex', 'ChatGPT (Codex)') +
    '<div class="row-end"><button class="ghost" id="recheck">Check again</button></div>';
  $('brains').querySelectorAll('[data-signin]').forEach((x) => { x.onclick = () => api.invoke('panel:openTerminal', x.dataset.signin); });
  $('brains').querySelectorAll('[data-open]').forEach((x) => { x.onclick = () => api.invoke('panel:openExternal', x.dataset.open); });
  $('recheck').onclick = async () => { $('recheck').textContent = 'Checking…'; status.brains = await api.invoke('panel:refreshBrains'); renderStatus(); };
}

function renderBanner() {
  const b = status.brains;
  const banner = $('setupBanner');
  if (!b) { banner.hidden = true; return; }
  const ready = ['claude', 'codex'].some((k) => b[k] && b[k].installed && b[k].loggedIn);
  if (ready) { banner.hidden = true; return; }
  banner.hidden = false;
  banner.innerHTML = 'Bluey thinks with your <b>Claude</b> or <b>ChatGPT</b> subscription through their command-line apps, and neither is signed in yet. '
    + '<button class="ghost" id="bannerSettings">Set up</button>';
  $('bannerSettings').onclick = () => showTab('settings');
}

// ───────────── Tabs ─────────────

function showTab(tab) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.id === 'tab-' + tab));
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab || (tab === 'session' && b.dataset.tab === 'sessions')));
  if (tab === 'sessions') loadSessions();
  if (tab === 'phone') api.invoke('panel:qr').then((q) => { if (q) { $('qr').innerHTML = q.svg; $('qrUrl').textContent = q.url; } });
  if (tab === 'settings' && !$('health').innerHTML) runHealth();
  if (tab === 'chat') { loadLive(); setTimeout(() => $('input').focus(), 50); }
}
document.querySelectorAll('nav button').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });
api.on('panel:tab', showTab);

// ───────────── Transcript rendering ─────────────

function time(ms) { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }

function entryHtml(e) {
  switch (e.kind) {
    case 'heard': return `<div class="e-heard"><time>${time(e.time)}</time>${e.speaker ? `<span class="spk spk-${esc(e.speaker)}">Speaker ${esc(e.speaker)}</span>` : ''}<div>${esc(e.text)}</div></div>`;
    case 'asked': return `<div class="e-asked"><div class="who">You asked · ${time(e.time)}</div><div class="b">${esc(e.text)}</div></div>`;
    case 'reply': return `<div class="e-reply"><canvas width="56" height="50" class="mini"></canvas><div class="b">${esc(e.text)}</div></div>`;
    case 'report': {
      const parts = String(e.text).split('\n\n');
      return `<div class="e-report"><div class="t">🔎 ${esc(parts[0])}</div><div class="p">${esc(parts.slice(1).join('\n\n'))}</div></div>`;
    }
    default: return `<div class="e-heard"><time>${time(e.time)}</time><div>${esc(e.text)}</div></div>`;
  }
}

function hydrate(container) {
  container.querySelectorAll('canvas.mini:not([data-done])').forEach((c) => { c.dataset.done = 1; drawMini(c); });
  container.querySelectorAll('.e-report .t:not([data-done])').forEach((t) => { t.dataset.done = 1; t.onclick = () => t.parentElement.classList.toggle('open'); });
}

function renderEntries(container, entries, emptyHtml) {
  container.innerHTML = entries.length ? entries.map(entryHtml).join('') : emptyHtml || '';
  hydrate(container);
  container.scrollTop = container.scrollHeight;
}

// ───────────── Live conversation ─────────────

let liveId = null;
const liveEmptyHtml = $('liveEntries').innerHTML;
async function loadLive() {
  sessions = await api.invoke('panel:sessions');
  const live = sessions.find((s) => s.live);
  liveId = live ? live.id : null;
  $('chatSub').textContent = live ? 'live session' : '';
  if (!live) { renderEntries($('liveEntries'), [], liveEmptyHtml); return; }
  const s = await api.invoke('panel:session', live.id);
  renderEntries($('liveEntries'), (s && s.entries) || [], liveEmptyHtml);
}

api.on('panel:entry', ({ session, entry }) => {
  if (session !== liveId) { loadLive(); return; }
  const box = $('liveEntries');
  const empty = box.querySelector('.empty');
  if (empty) empty.remove();
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.insertAdjacentHTML('beforeend', entryHtml(entry));
  hydrate(box);
  if (atBottom) box.scrollTop = box.scrollHeight;
  if (openSession && openSession.id === session) showSession(session);
});

api.on('panel:caption', ({ text, done }) => {
  const c = $('caption');
  c.hidden = !text || done;
  c.textContent = text || '';
  if (text && !done) talkUntil = performance.now() / 1000 + 0.6;
});

$('composer').onsubmit = (e) => {
  e.preventDefault();
  const text = $('input').value.trim();
  if (!text) return;
  $('input').value = '';
  api.invoke('panel:type', text);
};

$('toggle').onclick = () => api.invoke('panel:toggle');

// ───────────── Sessions ─────────────

function duration(sec) {
  const s = Math.round(sec);
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

async function loadSessions() {
  sessions = await api.invoke('panel:sessions');
  $('sessionCount').textContent = sessions.length ? `${sessions.length}` : '';
  $('sessions').innerHTML = sessions.length ? sessions.map((s) => `
    <div class="srow" data-id="${s.id}">
      <div class="main"><div class="when">${esc(new Date(s.started).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))}${s.live ? '<span class="live">LIVE</span>' : ''}</div>
      <div class="sum">${esc(s.summary)}</div></div>
      <div class="meta">${duration(s.duration)}<b>${s.questions} asked</b></div>
    </div>`).join('') : '<div class="empty"><div class="big">No sessions yet</div><p>Start one and your transcript and his replies show up here.</p></div>';
  document.querySelectorAll('.srow').forEach((r) => { r.onclick = () => showSession(r.dataset.id); });
}

async function showSession(id) {
  const s = await api.invoke('panel:session', id);
  if (!s) return;
  openSession = s;
  showTab('session');
  $('sTitle').textContent = new Date(s.started).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const asked = s.entries.filter((e) => e.kind === 'asked').length;
  $('sMeta').textContent = `${duration(((s.ended || Date.now()) - s.started) / 1000)} · ${asked} asked${s.source ? ' · ' + s.source : ''}`;
  renderEntries($('sEntries'), s.entries, '<div class="empty">Nothing was said in this session.</div>');
}

$('back').onclick = () => { openSession = null; showTab('sessions'); };
$('copyPrompt').onclick = async () => { await api.invoke('panel:copyPrompt', openSession.id); flashButton($('copyPrompt'), 'Copied ✓'); };
$('copyText').onclick = async () => { await api.invoke('panel:copyText', openSession.id); flashButton($('copyText'), 'Copied ✓'); };
$('openFolder').onclick = () => api.invoke('panel:openFolder', openSession.id);
$('openNotes').onclick = () => api.invoke('panel:openFolder', null);
$('deleteSession').onclick = async () => {
  if (!confirm('Delete this session, its notes and its audio? This can\'t be undone.')) return;
  await api.invoke('panel:delete', openSession.id);
  openSession = null;
  showTab('sessions');
};
api.on('panel:sessionsChanged', () => {
  if ($('tab-sessions').classList.contains('on')) loadSessions();
  if ($('tab-chat').classList.contains('on')) loadLive();
});

function flashButton(b, text) {
  const old = b.textContent;
  b.textContent = text;
  setTimeout(() => { b.textContent = old; }, 1600);
}

// ───────────── Phone ─────────────

function renderDevices() {
  const list = settings.devices || [];
  $('devices').innerHTML = list.length ? list.map((d) => `<div class="device"><div>${esc(d.name)}<div class="small">paired ${new Date(d.added).toLocaleDateString()}</div></div><button class="ghost danger" data-forget="${d.id}">Forget</button></div>`).join('')
    : '<div class="small">No phones paired yet.</div>';
  $('devices').querySelectorAll('[data-forget]').forEach((b) => {
    b.onclick = async () => { settings = await api.invoke('panel:forget', b.dataset.forget); renderDevices(); };
  });
}
function renderPhoneSetup() {
  const usb = status.usb || [];
  const ready = usb.find((d) => d.state === 'device');
  const unauthorized = usb.find((d) => d.state === 'unauthorized');
  $('usbBox').innerHTML = ready
    ? `<span class="dot on"></span><span class="grow">${esc(ready.model)} plugged in by USB</span><button class="pill" id="installPhone">Install Bluey on my phone</button>`
    : unauthorized ? '<span class="dot"></span><span class="grow">Phone plugged in: tap <b>Allow</b> on its "Allow USB debugging?" popup.</span>'
    : '<span class="dot"></span><span class="grow">No phone on USB. (Optional: only needed to install, or if Wi-Fi won&#39;t connect.)</span>';
  const b = $('installPhone');
  if (b) b.onclick = async () => {
    b.disabled = true; b.textContent = 'Installing…';
    const r = await api.invoke('panel:installPhone');
    b.disabled = false; b.textContent = 'Install Bluey on my phone';
    showToast(r.message);
  };
  const p = status.pairRequest;
  $('pairBox').innerHTML = p ? `<div class="pair"><div><b>${esc(p.name)}</b> wants to pair. Does the phone show these numbers?</div>
    <div class="nums">${esc(p.numbers)}</div><div class="row-btns"><button class="pill" id="allowPair">Allow</button><button class="ghost" id="denyPair">Don't allow</button></div></div>` : '';
  if (p) {
    $('allowPair').onclick = () => api.invoke('panel:pairAnswer', true);
    $('denyPair').onclick = () => api.invoke('panel:pairAnswer', false);
  }
}
$('firewall').onclick = () => api.invoke('panel:firewall');

// ───────────── Settings ─────────────

let modelChoices = null;
async function loadModels() {
  modelChoices = await api.invoke('panel:models');
  const opt = (v, label) => `<option value="${esc(v)}">${esc(label)}</option>`;
  $('claudeModel').innerHTML = opt('', 'From quick choice') + modelChoices.claude.models.map((m) => opt(m.id, m.name)).join('');
  $('claudeEffort').innerHTML = opt('', 'From quick choice') + modelChoices.claude.efforts.map((e) => opt(e, e)).join('');
  $('codexModel').innerHTML = opt('', "Your plan's newest default (updates itself)") + (modelChoices.codex || []).map((m) => opt(m.id, m.name + (m.isDefault ? ' (default)' : ''))).join('');
  fillCodexEfforts();
  fillSettings();
}
function fillCodexEfforts() {
  if (!modelChoices) return;
  const list = modelChoices.codex || [];
  const m = list.find((x) => x.id === (settings.codexModel || '')) || list.find((x) => x.isDefault) || list[0];
  const efforts = m ? m.efforts : ['low', 'medium', 'high'];
  $('codexEffort').innerHTML = '<option value="">From quick choice</option>' + efforts.map((e) => `<option value="${esc(e)}">${esc(e)}</option>`).join('');
  $('codexEffort').value = efforts.includes(settings.codexEffort) ? settings.codexEffort : '';
}
$('codexModel').addEventListener('change', () => setTimeout(fillCodexEfforts, 300));

function fillSettings() {
  document.querySelectorAll('[data-key]').forEach((el) => {
    const v = settings[el.dataset.key];
    if (el.type === 'checkbox') el.checked = !!v;
    else if (document.activeElement !== el) el.value = v == null ? '' : String(v);
  });
  if (!settings.personality && document.activeElement !== $('personality')) $('personality').value = defaultPersonality;
  renderDevices();
}

let saveTimer = null;
document.querySelectorAll('[data-key]').forEach((el) => {
  const commit = () => {
    let value = el.type === 'checkbox' ? el.checked : el.value;
    if (el.dataset.type === 'number') value = Number(value);
    if (el.dataset.key === 'personality' && value.trim() === defaultPersonality.trim()) value = '';
    api.invoke('panel:settings', { [el.dataset.key]: value }).then((s) => { settings = s; });
  };
  if (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type !== 'checkbox' && el.type !== 'range')) {
    el.addEventListener('input', () => { clearTimeout(saveTimer); saveTimer = setTimeout(commit, 700); });
    el.addEventListener('blur', commit);
  } else {
    el.addEventListener('change', commit);
  }
});
$('resetPersonality').onclick = () => { $('personality').value = defaultPersonality; api.invoke('panel:settings', { personality: '' }).then((s) => { settings = s; }); };
$('talkTest').onclick = () => { talkUntil = performance.now() / 1000 + 3; api.invoke('panel:talkTest'); };

async function listMics() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
    $('mics').innerHTML = '<option value="">Default</option>' + mics.map((m, i) => `<option value="${esc(m.deviceId)}">${esc(m.label || 'Microphone ' + (i + 1))}</option>`).join('');
    $('mics').value = settings.pcMicDevice || '';
  } catch {}
}

// ───────────── Messages ─────────────

let toastTimer = null;
function showToast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 6000);
}
api.on('panel:toast', (text) => {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
});
api.on('panel:status', (s) => { status = s; renderStatus(); });
api.on('panel:settings', (s) => { settings = s; fillSettings(); });

(async () => {
  const init = await api.invoke('panel:init');
  settings = init.settings; status = init.status; sessions = init.sessions; defaultPersonality = init.defaultPersonality;
  $('whisperModels').innerHTML = Object.entries(init.whisperModels).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  fillSettings();
  renderStatus();
  listMics();
  loadLive();
  loadModels();
})();
