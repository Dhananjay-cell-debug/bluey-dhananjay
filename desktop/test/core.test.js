// Unit and integration tests for Bluey's desktop logic. Run with: npm test
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { CursorEngine, TimingCurve } = require('../src/renderer/common/engine');
const { AudioSession, toWav, rms, RATE } = require('../src/main/audio');
const { NotesStore, markdown } = require('../src/main/notes');
const { Snapshot } = require('../src/main/screen');
const { parseReport } = require('../src/main/brain/research');
const prompts = require('../src/main/prompts');
const tools = require('../src/main/tools');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bluey-test-'));

// ───────────── Cursor motion ─────────────

test('timing curves start at 0, end at 1 and only go forward', () => {
  for (const curve of [TimingCurve.launch, TimingCurve.redirect, TimingCurve.steady]) {
    assert.equal(curve.value(0), 0);
    assert.equal(curve.value(1), 1);
    let last = 0;
    for (let x = 0; x <= 1; x += 0.01) { const v = curve.value(x); assert.ok(v >= last - 1e-9); last = v; }
  }
});

test('the cursor flies to a pinned spot, lands within a second and a bit, and fires onLand once', () => {
  const engine = new CursorEngine({ cursorSize: 72, phonePosition: 0.5, mood: 'listening' });
  const bounds = { width: 1920, height: 1080 };
  let landed = 0;
  engine.onLand = () => landed++;
  let now = 0;
  engine.step(1 / 60, now, { x: 0, y: 0 }, bounds);
  engine.setMode({ kind: 'pinned', x: 300, y: 200 });
  for (let i = 0; i < 120; i++) { now += 1 / 60; engine.step(1 / 60, now, { x: 0, y: 0 }, bounds); }
  assert.ok(Math.hypot(engine.tip.x - 300, engine.tip.y - 200) < 0.5, 'arrived');
  assert.equal(landed, 1);
  assert.ok(engine.opacity > 0.9, 'visible while pointing');
  // Going home in follow mode fades out.
  engine.setMode({ kind: 'following' });
  for (let i = 0; i < 180; i++) { now += 1 / 60; engine.step(1 / 60, now, { x: 0, y: 0 }, bounds); }
  assert.ok(engine.opacity < 0.05);
});

test('a change of plans mid-flight has no jump in position', () => {
  const engine = new CursorEngine({ cursorSize: 72, phonePosition: 0.5 });
  const bounds = { width: 1920, height: 1080 };
  let now = 0;
  engine.step(1 / 60, now, { x: 0, y: 0 }, bounds);
  engine.setMode({ kind: 'pinned', x: 1500, y: 200 });
  for (let i = 0; i < 20; i++) { now += 1 / 60; engine.step(1 / 60, now, { x: 0, y: 0 }, bounds); }
  const before = { ...engine.tip };
  engine.setMode({ kind: 'pinned', x: 200, y: 800 });
  now += 1 / 60; engine.step(1 / 60, now, { x: 0, y: 0 }, bounds);
  assert.ok(Math.hypot(engine.tip.x - before.x, engine.tip.y - before.y) < 80, 'continuous');
});

test('his face looks toward the cursor, gets drowsy when the mouse rests, and moods win', () => {
  const engine = new CursorEngine({ cursorSize: 72, phonePosition: 0.5, mood: 'listening' });
  const bounds = { width: 1920, height: 1080 };
  engine.step(1 / 60, 0, { x: 1900, y: 100 }, bounds);
  let face = engine.face(bounds, 0.1);
  assert.ok(face.gx > 0.5, 'looks right at the mouse');
  assert.equal(face.mood, 'listening');
  assert.equal(engine.face(bounds, 8).mood, 'sleepy');
  assert.equal(engine.face(bounds, 20).mood, 'resting');
  engine.brainMood = 'thinking';
  assert.equal(engine.face(bounds, 20).mood, 'thinking');
});

// ───────────── Audio ─────────────

function tone(seconds, amp = 6000, freq = 220) {
  const out = new Int16Array(Math.round(seconds * RATE));
  for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.sin(2 * Math.PI * freq * i / RATE) * amp * (0.6 + 0.4 * Math.sin(i / 900)));
  return out;
}
const silence = (seconds) => new Int16Array(Math.round(seconds * RATE));
function feed(session, samples) { for (let i = 0; i < samples.length; i += 1600) session.push(samples.slice(i, i + 1600)); }

test('voice detection finds an utterance between silences', () => {
  const s = new AudioSession({});
  const found = [];
  s.on('utterance', (u) => found.push(u));
  feed(s, silence(1)); feed(s, tone(1.5)); feed(s, silence(1.5));
  assert.equal(found.length, 1);
  const seconds = (found[0].end - found[0].start) / RATE;
  assert.ok(seconds > 1.2 && seconds < 2.4, `utterance length ${seconds}`);
});

test('speech said while holding is the question, not background talk', async () => {
  const s = new AudioSession({});
  const found = [];
  s.on('utterance', (u) => found.push(u));
  feed(s, silence(0.5));
  s.beginAsk();
  feed(s, tone(1.2));
  const clip = s.endAsk(0);
  feed(s, silence(1.5));
  const q = await clip;
  assert.ok(q.seconds > 1.2 && q.seconds < 1.8, `question length ${q.seconds}`);
  assert.ok(q.level > 0.05);
  assert.equal(found.length, 0, 'not reported as overheard');
});

test('wav files are well formed and session audio is saved in chunks', () => {
  const wav = toWav(tone(0.5));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(40), 0.5 * RATE * 2);
  const dir = tmp();
  const s = new AudioSession({ audioFolder: dir });
  feed(s, tone(1));
  s.finish();
  const files = fs.readdirSync(dir);
  assert.deepEqual(files, ['chunk-001.wav']);
  const saved = fs.readFileSync(path.join(dir, files[0]));
  assert.equal(saved.readUInt32LE(40), RATE * 2);
  assert.ok(rms(tone(0.1)) > 0.05);
});

// ───────────── Notes ─────────────

test('notes keep time order, write markdown and json, and drop empty sessions', () => {
  const root = tmp();
  const notes = new NotesStore(root, { userName: 'Dhananjay' });
  const s = notes.start({ source: 'Pixel 8' });
  notes.add('heard', 'so the launch is friday', { time: Date.now() - 2000 });
  notes.add('asked', "what's this button?");
  notes.add('reply', "That's the publish button, mate.");
  notes.add('heard', 'earlier line', { time: Date.now() - 5000 });
  assert.equal(notes.current.entries[0].text, 'earlier line');
  notes.save(true);
  const md = fs.readFileSync(path.join(s.folder, 'notes.md'), 'utf8');
  assert.match(md, /Dhananjay asked Bluey 1 question/);
  assert.match(md, /> \*\*Bluey:\*\* That's the publish button, mate\./);
  assert.match(md, /Listening on: Pixel 8/);
  notes.end();
  const list = notes.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].questions, 1);
  assert.equal(list[0].summary, "what's this button?");
  assert.match(notes.agentPrompt(list[0].id), /notes\.md/);
  assert.ok(fs.existsSync(path.join(root, 'README.md')));
  // A session with nothing said is not kept.
  const empty = notes.start({});
  notes.end();
  assert.ok(!fs.existsSync(empty.folder));
  assert.ok(notes.delete(list[0].id));
  assert.equal(notes.list().length, 0);
});

test('markdown marks research reports and questions', () => {
  const md = markdown({ started: 0, ended: 60000, entries: [{ kind: 'report', text: 'Title\n\nPara', time: 1 }, { kind: 'asked', text: 'q', time: 2 }] });
  assert.match(md, /> \*\*Research report:\*\*\n> Title/);
  assert.match(md, /You asked Bluey/);
});

// ───────────── Screen ─────────────

const raw = {
  width: 3840, height: 2160, left: 0, top: 0, jpeg: 'x', app: 'Chrome', title: 'Docs',
  lines: [
    { text: 'Publish now', x: 200, y: 100, w: 400, h: 40, words: [{ text: 'Publish', x: 200, y: 100, w: 220, h: 40 }, { text: 'now', x: 440, y: 100, w: 160, h: 40 }] },
    { text: 'Total 391', x: 2000, y: 1600, w: 300, h: 50, words: [{ text: 'Total', x: 2000, y: 1600, w: 150, h: 50 }, { text: '391', x: 2170, y: 1600, w: 130, h: 50 }] },
  ],
  controls: [{ kind: 'button', label: 'Share', x: 3500, y: 40, w: 200, h: 80 }],
};

test('a look turns OCR and controls into ids, DIP rects and grid positions', () => {
  const shot = new Snapshot(raw, { width: 1920, height: 1080 });
  assert.equal(shot.scale, 2);
  const w = shot.target('w2');
  assert.equal(w.text, 'now');
  assert.deepEqual(w.rect, { x: 220, y: 50, w: 80, h: 20 });
  assert.equal(shot.target('C1').text, 'Share');
  assert.equal(shot.target('L2').text, 'Total 391');
  assert.equal(shot.target('W99'), null);
  const list = shot.targetList;
  assert.match(list, /Frontmost app: Chrome/);
  assert.match(list, /C1 button @938,37 "Share"/);
  assert.match(list, /L1 @104,56 "Publish now" \| W1=Publish W2=now/);
  assert.deepEqual(shot.toPhysical({ x: 100, y: 50 }), { x: 200, y: 100 });
  assert.equal(shot.targetNear({ x: 1150, y: 812 }).text, '391');
  assert.equal(shot.targetNear({ x: 10, y: 1000 }), null);
  assert.deepEqual(shot.gridPoint(500, 2000), { x: 960, y: 1080 });
});

// ───────────── Research ─────────────

test('research reports parse from clean JSON, fenced JSON, or plain text', () => {
  const a = parseReport('{"title":"Eiffel Tower height","paragraphs":["It is 330 m."],"sources":[{"title":"Site","url":"https://x.com/a"},{"title":"bad","url":"javascript:1"}]}', 'q');
  assert.equal(a.title, 'Eiffel Tower height');
  assert.equal(a.sources.length, 1);
  const b = parseReport('Sure!\n```json\n{"title":"**Bold** title","paragraphs":["[link](https://x) text"]}\n```', 'q');
  assert.equal(b.title, 'Bold title');
  assert.equal(b.paragraphs[0], 'link text');
  const c = parseReport('Plain title\nFirst para\nSecond', 'q');
  assert.equal(c.title, 'Plain title');
  assert.equal(c.paragraphs.length, 2);
  assert.throws(() => parseReport('', 'q'));
});

// ───────────── Prompts and tools ─────────────

test('instructions include the computer guide only when computer control is on', () => {
  assert.match(prompts.instructions({ computerControl: true }), /Safety rules/);
  assert.doesNotMatch(prompts.instructions({ computerControl: false }), /Safety rules/);
  assert.match(prompts.instructions({ personality: 'You are a pirate.', computerControl: false }), /^You are a pirate\./);
  assert.match(prompts.instructions({ userName: 'Dhananjay' }), /The user's name is Dhananjay/);
});

test('the question message carries overheard context, the question and the fresh look', () => {
  const m = prompts.questionMessage({ overheard: [{ time: '10:01', text: 'launch is friday' }], question: "what's this?", look: 'L1 "hi"' });
  assert.match(m, /\(10:01\) launch is friday/);
  assert.match(m, /\[The user is asking you now/);
  assert.match(m, /fresh look at the screen/);
  assert.ok(m.indexOf("what's this?") < m.indexOf('L1 "hi"'));
});

test('tool list switches with computer control and every tool has a schema', () => {
  assert.equal(tools.list(false).length, 6);
  assert.equal(tools.list(true, true).length, 24);
  assert.equal(tools.list(true).length, 15);
  for (const t of tools.list(true)) {
    assert.equal(t.inputSchema.type, 'object');
    assert.ok(t.description.length > 20);
  }
  assert.ok(tools.actionNames.has('click') && !tools.actionNames.has('point_at'));
});
