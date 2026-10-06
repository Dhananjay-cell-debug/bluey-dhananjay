'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Bluey } = require('../src/main/bluey');
const { PhoneServer } = require('../src/main/phone');
const edge = require('../src/main/edge-tts');

function fixture(phone = false) {
  const sent = [], spoken = [];
  const settings = Object.assign(new EventEmitter(), { get: k => ({ speakReplies: true, speakEngine: 'neural', chirpVolume: 0.6, captions: true })[k] });
  const host = Object.assign(new EventEmitter(), { setSpeaking() {} });
  const bluey = new Bluey({ settings, host, overlay: { send: (c, m) => sent.push([c, m]) },
    phones: { broadcast: m => sent.push(['phone', m]), speak: m => { if (phone) spoken.push(m); return phone; } } });
  return { bluey, sent, spoken };
}

test('a slow voice survives the caption expiring, but a new question cancels it', async t => {
  let resolve;
  t.mock.method(edge, 'synth', () => new Promise(r => { resolve = r; }));
  const { bluey, sent } = fixture();
  const pending = bluey.speak('Hello');
  bluey.clearCaption(false);
  resolve(Buffer.from('mp3'));
  await pending;
  assert.equal(sent.filter(([c, m]) => c === 'overlay:playAudio' && m).length, 1);
  const interrupted = bluey.speak('Never play this');
  bluey.clearCaption();
  resolve(Buffer.from('stale'));
  await interrupted;
  assert.equal(sent.filter(([c, m]) => c === 'overlay:playAudio' && m).length, 1);
  assert.ok(sent.some(([c, m]) => c === 'phone' && m.t === 'voice' && m.stop));
});

test('neural replies reach the phone, and service failure sends text for Android speech', async t => {
  const synth = t.mock.method(edge, 'synth', async () => Buffer.from('mp3'));
  const { bluey, sent, spoken } = fixture(true);
  await bluey.speak('Hi from your phone');
  assert.equal(spoken[0].base64, Buffer.from('mp3').toString('base64'));
  assert.equal(spoken[0].text, 'Hi from your phone');
  assert.ok(!sent.some(([c, m]) => c === 'overlay:playAudio' && m));
  synth.mock.mockImplementation(async () => { throw new Error('offline'); });
  await bluey.speak('Offline reply');
  assert.equal(spoken[1].text, 'Offline reply');
  assert.equal(spoken[1].base64, undefined);
});

test('voice routing skips old and disconnected phones and selects only one speaker', () => {
  const sent = [];
  const server = Object.create(PhoneServer.prototype);
  server.phones = new Map([
    [{ readyState: 1 }, { paired: true, voice: false }],
    [{ readyState: 3 }, { paired: true, voice: true }],
    [{ readyState: 1 }, { paired: true, voice: true }],
    [{ readyState: 1 }, { paired: true, voice: true }],
  ]);
  server.send = (ws, m) => sent.push(m);
  assert.equal(server.speak({ text: 'hello' }), true);
  assert.deepEqual(sent, [{ text: 'hello', t: 'voice' }]);
  server.phones.clear();
  assert.equal(server.speak({ text: 'hello' }), false);
});

test('an unavailable model retries the other signed-in brain only once', () => {
  const { bluey } = fixture();
  const asked = [];
  bluey.brainName = 'codex';
  bluey.lastAsk = { message: 'Say hello', image: null };
  bluey.brainStatus = () => ({ claude: { installed: true, loggedIn: true } });
  bluey.notes = { recentText: () => '' };
  bluey.stopBrain = () => {};
  bluey.startBrain = () => { bluey.brainName = 'claude'; bluey.brain = { ask: text => asked.push(text) }; };
  bluey.onTurnEnd({ error: "model 'example' is not enabled in the service" });
  assert.deepEqual(asked, ['Say hello']);
  assert.equal(bluey.lastAsk.retried, true);
  let failure;
  bluey.fail = text => { failure = text; };
  bluey.onTurnEnd({ error: 'usage limit' });
  assert.equal(asked.length, 1);
  assert.equal(failure, 'usage limit');
});
