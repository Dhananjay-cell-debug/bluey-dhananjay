// Tests for the phone link (real WebSocket on localhost) and the brain stream parsers.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const crypto = require('crypto');
const { PhoneServer } = require('../src/main/phone');
const { ClaudeBrain } = require('../src/main/brain/claude');
const { CodexBrain } = require('../src/main/brain/codex');
const { Whisper } = require('../src/main/whisper');
const { normalizeKeys, REFUSED_KEYS } = (() => {
  // host.js needs Electron's shell; stub it for this test.
  const Module = require('module');
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'electron' ? { shell: {} } : orig.call(this, req, ...rest); };
  try { return require('../src/main/host'); } finally { Module._load = orig; }
})();

const secure = require('../src/main/secure');
const { PhoneSim } = require('../src/main/phone-sim');

// Shared with android/app/src/test/.../SecureTest.kt: both sides must produce exactly these bytes.
const VECTORS = {
  phonePriv: '1'.repeat(64), pcPriv: '2'.repeat(64), phoneNonce: 'aa'.repeat(16), pcNonce: 'bb'.repeat(16),
  key: '4d9a0b2e82874d9326e93576425c1df5ee8e4535f5d6c79515424252dd509e89',
  numbers: '281 357',
  frame: '000000010000000000000000ec1ca4a4064e8a3503e7ca19f78a05d25d8d64d1f319a90c1e4abd',  // {"t":"hi"} phone->pc, counter 0
};

test('the secure link matches its test vectors and rejects tampering, replays and the wrong direction', () => {
  const phone = secure.identityFromPrivate(VECTORS.phonePriv), pc = secure.identityFromPrivate(VECTORS.pcPriv);
  const pn = Buffer.from(VECTORS.phoneNonce, 'hex'), cn = Buffer.from(VECTORS.pcNonce, 'hex');
  const k = secure.sessionKey(phone, pc.pub, pn, cn);
  assert.equal(k.toString('hex'), VECTORS.key);
  assert.ok(secure.sessionKey(pc, phone.pub, pn, cn).equals(k), 'both sides agree');
  assert.equal(secure.verificationNumbers(pc.pub, phone.pub), VECTORS.numbers);
  const sender = new secure.Channel(k, secure.PHONE_TO_PC);
  const frame = sender.seal(secure.KIND_TEXT, Buffer.from('{"t":"hi"}'));
  assert.equal(frame.toString('hex'), VECTORS.frame);
  const receiver = new secure.Channel(k, secure.PC_TO_PHONE);
  assert.equal(receiver.open(frame).payload.toString(), '{"t":"hi"}');
  assert.equal(receiver.open(frame), null, 'replay rejected');
  const second = sender.seal(secure.KIND_TEXT, Buffer.from('x'));
  const tampered = Buffer.from(second); tampered[14] ^= 1;
  assert.equal(receiver.open(tampered), null, 'tampering rejected');
  assert.ok(receiver.open(second));
  const echo = new secure.Channel(k, secure.PHONE_TO_PC);
  assert.equal(echo.open(new secure.Channel(k, secure.PHONE_TO_PC).seal(1, Buffer.from('x'))), null, 'own direction rejected');
});

test('a new phone pairs only when you click Allow, after which it reconnects without asking', async () => {
  let devices = [];
  const identity = secure.identityFromPrivate(crypto.randomBytes(32).toString('hex'));
  const server = new PhoneServer({ devices, save: (d) => { devices = d; }, name: 'Test PC', identity });
  const requests = [];
  server.on('pairRequest', (r) => { if (r) requests.push(r); });
  const commands = [];
  server.on('command', (m) => commands.push(m.t));
  const audio = [];
  server.on('audio', ({ data }) => audio.push(data.length));
  await server.start();
  const url = `ws://127.0.0.1:${server.port}/`;

  const phone = new PhoneSim({ name: 'Pixel', identityHex: crypto.randomBytes(32).toString('hex') });
  const hello = await phone.connect(url);
  assert.equal(hello.paired, false);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].numbers, hello.numbers, 'same six digits on both screens');
  // Not allowed yet: commands and audio are ignored.
  phone.send({ t: 'toggle' });
  phone.sendAudio(Buffer.alloc(3200));
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(commands, []);
  requests[0].allow();
  assert.ok(await phone.next('paired'));
  assert.equal(devices.length, 1);
  phone.send({ t: 'toggle' });
  phone.sendAudio(Buffer.alloc(3200));
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(commands, ['toggle']);
  assert.deepEqual(audio, [3200]);
  assert.deepEqual(server.list(), ['Pixel']);
  phone.close();

  // Same phone again: recognised by its key, no prompt.
  const again = new PhoneSim({ name: 'Pixel', identityHex: phone.identity.ecdh.getPrivateKey('hex') });
  assert.equal((await again.connect(url)).paired, true);
  server.face({ gx: 0.1, gy: -0.2, mood: 'happy', talk: 0 });
  assert.equal((await again.next('face')).mood, 'happy');
  again.close();

  // A stranger is denied and disconnected.
  const stranger = new PhoneSim({ name: 'Stranger' });
  await stranger.connect(url);
  await new Promise((r) => setTimeout(r, 100));
  requests[requests.length - 1].deny();
  assert.ok(await stranger.next('pairDenied'));
  assert.equal(requests.length, 2);
  // An old (v1) app is told to update instead of being let in.
  const old = new WebSocket(url);
  const upgrade = await new Promise((r) => { old.on('open', () => old.send(JSON.stringify({ t: 'hello', v: 1 }))); old.on('message', (d) => r(JSON.parse(d.toString()))); });
  assert.equal(upgrade.upgrade, true);
  server.stop();
});

test('the Claude brain parses streaming text, tool calls, replies and the final result', () => {
  const brain = new ClaudeBrain({ instructions: '', toolNames: [], bridge: {}, workDir: '.' });
  brain.proc = { stdin: { write() {} } };
  const events = [];
  for (const e of ['turnStart', 'text', 'toolStart', 'reply', 'turnEnd']) brain.on(e, (d) => events.push([e, d]));
  brain.ask('hi');
  const line = (o) => brain.onLine(JSON.stringify(o));
  line({ type: 'stream_event', event: { type: 'message_start' } });
  line({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'mcp__bluey__look_at_screen' } } });
  line({ type: 'stream_event', event: { type: 'message_start' } });
  line({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'That is ' } } });
  line({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'the button.' } } });
  line({ type: 'assistant', message: { content: [{ type: 'text', text: 'That is the button.' }] } });
  line({ type: 'result', subtype: 'success', result: 'That is the button.' });
  const names = events.map((e) => e[0]);
  assert.deepEqual(names, ['turnStart', 'toolStart', 'text', 'text', 'reply', 'turnEnd']);
  assert.equal(events[1][1].name, 'look_at_screen');
  assert.equal(events[3][1], 'That is the button.');
  assert.equal(events[5][1].text, 'That is the button.');
  assert.equal(brain.busy, false);
});

test('an interrupted Claude turn never leaks into the next one', () => {
  const brain = new ClaudeBrain({ instructions: '', toolNames: [], bridge: {}, workDir: '.' });
  const written = [];
  brain.proc = { stdin: { write(s) { written.push(JSON.parse(s)); } } };
  const ends = [];
  const texts = [];
  brain.on('turnEnd', (r) => ends.push(r));
  brain.on('text', (t) => texts.push(t));
  brain.ask('first');
  brain.ask('second');  // interrupts the first
  assert.ok(written.some((w) => w.type === 'control_request' && w.request.subtype === 'interrupt'));
  assert.equal(ends.length, 1);
  assert.equal(ends[0].interrupted, true);
  const line = (o) => brain.onLine(JSON.stringify(o));
  line({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'old' } } });
  line({ type: 'result', subtype: 'error_during_execution', is_error: true });  // the first turn's result
  assert.equal(ends.length, 1, 'old result ignored');
  assert.deepEqual(texts, [], 'old text ignored');
  line({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'new' } } });
  line({ type: 'result', subtype: 'success', result: 'new' });
  assert.equal(ends.length, 2);
  assert.equal(ends[1].text, 'new');
});

test('usage limits are explained in plain words', () => {
  const brain = new ClaudeBrain({ instructions: '', toolNames: [], bridge: {}, workDir: '.' });
  brain.proc = { stdin: { write() {} } };
  let end = null;
  brain.on('turnEnd', (r) => { end = r; });
  brain.ask('x');
  brain.onLine(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'Claude AI usage limit reached' }));
  assert.match(end.error, /usage limit/);
});

test('the Codex brain follows deltas, replies and turn completion', () => {
  const brain = new CodexBrain({ instructions: '', toolNames: [], bridge: {}, workDir: '.' });
  brain.proc = { stdin: { write() {} } };
  brain.busy = true; brain.turnId = 't1';
  const events = [];
  for (const e of ['text', 'toolStart', 'reply', 'turnEnd']) brain.on(e, (d) => events.push([e, d]));
  const line = (o) => brain.onLine(JSON.stringify(o));
  line({ method: 'item/started', params: { turnId: 't1', item: { type: 'mcpToolCall', tool: 'point_at' } } });
  line({ method: 'item/started', params: { turnId: 't1', item: { type: 'agentMessage' } } });
  line({ method: 'item/agentMessage/delta', params: { turnId: 't1', delta: 'Hi ' } });
  line({ method: 'item/agentMessage/delta', params: { turnId: 'other', delta: 'NOPE' } });
  line({ method: 'item/agentMessage/delta', params: { turnId: 't1', delta: 'there' } });
  line({ method: 'item/completed', params: { turnId: 't1', item: { type: 'agentMessage', text: 'Hi there' } } });
  line({ method: 'turn/completed', params: { turn: { id: 't1' } } });
  assert.deepEqual(events.map((e) => e[0]), ['toolStart', 'text', 'text', 'reply', 'turnEnd']);
  assert.equal(events[2][1], 'Hi there');
  assert.equal(events[4][1].text, 'Hi there');
});

test('whisper hallucinations and noise tags are cleaned out', () => {
  assert.equal(Whisper.clean(' [BLANK_AUDIO] '), '');
  assert.equal(Whisper.clean('Thank you.'), '');
  assert.equal(Whisper.clean('(music) Hey Bluey, open Spotify'), 'Hey Bluey, open Spotify');
});

test('lock, log-out and security-screen shortcuts are refused', () => {
  for (const k of ['Win + L', 'ctrl+alt+delete', 'Ctrl+Shift+Escape', 'control+alt+del']) assert.ok(REFUSED_KEYS.has(normalizeKeys(k)), k);
  for (const k of ['ctrl+t', 'cmd+l', 'alt+tab']) assert.ok(!REFUSED_KEYS.has(normalizeKeys(k)), k);
});
