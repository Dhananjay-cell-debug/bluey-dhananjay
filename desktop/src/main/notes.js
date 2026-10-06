// Every session, kept as plain files any agent can read: Documents/Bluey Notes/<date> <id>/
//   notes.md      the transcript with times, your questions, his replies and research reports. Start here.
//   session.json  the same data, structured.
//   audio/        the raw recording, as five-minute WAV chunks.
// This folder is the single source of truth: the phone and the desktop panel both read sessions from here.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const pad = (n) => String(n).padStart(2, '0');
function folderStamp(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`; }
function clock(ms) { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }); }

function summaryOf(s) {
  const asked = s.entries.find((e) => e.kind === 'asked' && e.text);
  const heard = s.entries.find((e) => e.kind === 'heard' && e.text);
  return (asked || heard || {}).text || 'Nothing said yet';
}

function markdown(s, userName) {
  const who = userName || 'You';
  const day = new Date(s.started).toLocaleString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const out = [`# Bluey session: ${day}`, ''];
  if (s.ended) {
    const minutes = Math.round((s.ended - s.started) / 60000);
    out.push(`Ended ${clock(s.ended)} (${Math.floor(minutes / 60)}h ${minutes % 60}m).`);
  } else {
    out.push('Still recording.');
  }
  const asked = s.entries.filter((e) => e.kind === 'asked').length;
  if (asked) out.push(`${who} asked Bluey ${asked} question(s); they're marked inline below.`);
  if (s.source) out.push(`Listening on: ${s.source}.`);
  out.push('', '## Transcript', '');
  for (const e of s.entries) {
    const text = String(e.text || '').trim();
    if (!text) continue;
    const time = clock(e.time);
    switch (e.kind) {
      case 'heard': out.push(e.speaker ? `**[${time}] Speaker ${e.speaker}:** ${text}` : `**[${time}]** ${text}`); break;
      case 'asked': out.push(`> **[${time}] ${who} asked Bluey:** ${text}`); break;
      case 'reply': out.push(`> **Bluey:** ${text}`); break;
      case 'report': out.push('> **Research report:**\n' + text.split('\n').map((l) => '> ' + l).join('\n')); break;
      default: out.push(`[${time}] ${text}`);
    }
    out.push('');
  }
  return out.join('\n');
}

const README = `# Bluey Notes

Meeting notes recorded by Bluey (the blueberry on your phone and PC). One folder per listening session, named by start time.

In each session folder:
- \`notes.md\`: the full transcript with timestamps, plus your questions to Bluey, Bluey's replies and any research reports, in time order. Start here.
- \`session.json\`: the same data, structured.
- \`audio/\`: the raw recording, as five-minute WAV chunks (16 kHz mono).

Transcripts are made on this PC with whisper.cpp, so they never leave your computer.
`;

class NotesStore extends EventEmitter {
  constructor(root, { userName } = {}) {
    super();
    this.root = root;
    this.userName = userName;
    this.current = null;
    this.saveTimer = null;
  }

  ensureRoot() {
    fs.mkdirSync(this.root, { recursive: true });
    const readme = path.join(this.root, 'README.md');
    if (!fs.existsSync(readme)) fs.writeFileSync(readme, README);
  }

  /** Starts a session and returns it. */
  start({ source, brain } = {}) {
    this.end();
    this.ensureRoot();
    const id = crypto.randomUUID();
    const started = Date.now();
    const folder = path.join(this.root, `${folderStamp(new Date(started))} ${id.slice(0, 8)}`);
    fs.mkdirSync(path.join(folder, 'audio'), { recursive: true });
    this.current = { id, started, ended: null, entries: [], source: source || null, brain: brain || null, folder };
    this.save(true);
    this.emit('changed', this.current.id);
    return this.current;
  }

  add(kind, text, { time, id } = {}) {
    if (!this.current) return null;
    text = String(text || '').trim();
    if (!text) return null;
    const entry = { id: id || crypto.randomUUID(), kind, text, time: time || Date.now() };
    const map = (kind === 'heard' || kind === 'asked') && (this.speakerMaps || []).find((m) => m.id === this.current.id
      && entry.time >= m.chunkStart - 1000 && entry.time <= m.chunkEnd);
    if (map) { const letter = map.label(entry.time); if (letter) entry.speaker = letter; }
    const list = this.current.entries;
    list.push(entry);
    // Keep time order (background lines can be transcribed a moment after a later question).
    for (let i = list.length - 1; i > 0 && list[i].time < list[i - 1].time; i--) [list[i], list[i - 1]] = [list[i - 1], list[i]];
    this.save();
    this.emit('entry', { session: this.current.id, entry });
    return entry;
  }

  end() {
    const s = this.current;
    if (!s) return;
    this.current = null;
    s.ended = Date.now();
    const empty = s.entries.length === 0 && s.ended - s.started < 20000;
    if (empty) {
      // A few seconds with nothing said: don't keep it.
      try { fs.rmSync(s.folder, { recursive: true, force: true }); } catch {}
    } else {
      this.write(s);
    }
    this.emit('changed', s.id);
  }

  save(now) {
    clearTimeout(this.saveTimer);
    if (now) { if (this.current) this.write(this.current); return; }
    this.saveTimer = setTimeout(() => this.current && this.write(this.current), 1500);
  }

  write(s) {
    try {
      const { folder, ...data } = s;
      fs.writeFileSync(path.join(folder, 'session.json'), JSON.stringify(data, null, 2));
      fs.writeFileSync(path.join(folder, 'notes.md'), markdown(s, this.userName));
    } catch (e) {
      this.emit('warning', 'Could not save notes: ' + e.message);
    }
  }

  /** Adds speaker letters to the lines said during one audio chunk of session `id` (and to any transcribed later). */
  labelSpeakers(id, chunkStart, chunkEnd, label) {
    this.speakerMaps = (this.speakerMaps || []).filter((m) => Date.now() - m.at < 30 * 60 * 1000);
    this.speakerMaps.push({ id, chunkStart, chunkEnd, label, at: Date.now() });
    const live = this.current && this.current.id === id;
    const s = live ? this.current : this.get(id);
    if (!s) return 0;
    let n = 0;
    for (const e of s.entries) {
      if ((e.kind !== 'heard' && e.kind !== 'asked') || e.time < chunkStart - 1000 || e.time > chunkEnd) continue;
      const letter = label(e.time);
      if (letter && e.speaker !== letter) { e.speaker = letter; n++; }
    }
    if (n) { if (live) this.save(true); else this.write(s); this.emit('changed', id); }
    return n;
  }

  get audioFolder() { return this.current ? path.join(this.current.folder, 'audio') : null; }

  /** Recent lines from this session, for a fresh brain to pick up where the last one left off. */
  recentText(limit = 6000) {
    if (!this.current) return '';
    const text = this.current.entries.filter((e) => e.kind !== 'report')
      .map((e) => (e.kind === 'reply' ? 'Bluey: ' : e.kind === 'asked' ? 'Asked: ' : '') + e.text).join('\n');
    return text.slice(-limit);
  }

  folders() {
    try {
      return fs.readdirSync(this.root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(this.root, d.name));
    } catch { return []; }
  }

  read(folder) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(folder, 'session.json'), 'utf8'));
      data.folder = folder;
      return data;
    } catch { return null; }
  }

  /** Every session, newest first, as short summaries. */
  list() {
    const sessions = [];
    for (const folder of this.folders()) {
      const s = this.current && folder === this.current.folder ? this.current : this.read(folder);
      if (!s || !s.id) continue;
      sessions.push({
        id: s.id, started: s.started, ended: s.ended, live: !!(this.current && this.current.id === s.id),
        summary: summaryOf(s), questions: s.entries.filter((e) => e.kind === 'asked').length,
        duration: ((s.ended || Date.now()) - s.started) / 1000, folder,
      });
    }
    return sessions.sort((a, b) => b.started - a.started);
  }

  get(id) {
    if (this.current && this.current.id === id) return this.current;
    const folder = this.folders().find((f) => f.endsWith(' ' + String(id).slice(0, 8)));
    return folder ? this.read(folder) : null;
  }

  delete(id) {
    if (this.current && this.current.id === id) return false;
    const s = this.get(id);
    if (!s) return false;
    fs.rmSync(s.folder, { recursive: true, force: true });
    this.emit('changed', id);
    return true;
  }

  /** A prompt for an agent (like Claude Code) that points it at a session's notes. */
  agentPrompt(id) {
    const s = this.get(id);
    if (!s) return '';
    const when = new Date(s.started).toLocaleString([], { dateStyle: 'full', timeStyle: 'short' });
    return `I recorded a meeting with my Bluey app on ${when}. The notes are in ${s.folder}

- notes.md: the full transcript with timestamps, plus my questions to Bluey, its replies and research reports. Start here.
- session.json: the same data, structured.
- audio/: the original recording in five-minute WAV chunks.

All my sessions are in ${this.root}, one folder per session (see README.md there). Read the notes, then help me with: `;
  }

  exportText(id) {
    const s = this.get(id);
    if (!s) return '';
    const names = { heard: 'Heard', asked: 'You asked', reply: 'Bluey', report: 'Research' };
    return [`Bluey session, ${new Date(s.started).toLocaleString()}`, '',
      ...s.entries.filter((e) => e.text).map((e) => `[${clock(e.time)}] ${names[e.kind] || e.kind}: ${e.text}`)].join('\n');
  }
}

module.exports = { NotesStore, markdown, summaryOf };
