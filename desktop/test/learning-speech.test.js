'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Learning } = require('../src/main/learning');
const { ReplySpeech } = require('../src/main/reply-speech');

test('learning persists, edits, retrieves relevant workflows and forgets', t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'bluey-learning-'));
  t.after(() => fs.rmSync(folder, { recursive: true }));
  const settings = { get: () => true };
  const file = path.join(folder, 'guide.json');
  const memory = new Learning(file, settings);
  const item = memory.put({ kind: 'prompt_style', text: 'Claude prompts need context, requirements and completion criteria.' });
  memory.put({ kind: 'workflow', text: 'Open WhatsApp, locate the named chat, draft and verify before sending.' });
  const reopened = new Learning(file, settings);
  assert.equal(reopened.items.length, 2);
  assert.match(reopened.context('Write a Claude prompt'), /completion criteria/);
  assert.equal(reopened.items.find(i => i.id === item.id).uses, 1);
  reopened.put({ id: item.id, kind: 'prompt_style', text: 'Use concise Claude prompts with clear acceptance criteria.' });
  assert.equal(reopened.items.length, 2);
  assert.match(reopened.context('Claude prompt'), /acceptance criteria/);
  reopened.remove(item.id);
  assert.equal(new Learning(file, settings).items.length, 1);
});

test('paused learning supplies no context, rejects secrets and unknown edits', t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'bluey-learning-'));
  t.after(() => fs.rmSync(folder, { recursive: true }));
  const memory = new Learning(path.join(folder, 'guide.json'), { get: () => false });
  memory.put({ text: 'Prefer Hinglish explanations.' });
  assert.equal(memory.context('Explain'), '');
  assert.throws(() => memory.put({ text: 'My password is secret' }), /credentials/);
  assert.throws(() => memory.put({ id: 'gone', text: 'Remember this' }), /no longer exists/);
});

test('speech prepares ahead but preserves sentence order until actual completion', async t => {
  const sent = [], ready = new Map();
  const speech = new ReplySpeech({ synth: text => new Promise(resolve => ready.set(text, resolve)), deliver: m => sent.push(m), stopped() {}, warning() {} });
  t.after(() => speech.cancel());
  const first = speech.add('First sentence.');
  const second = speech.add('Second sentence.');
  ready.get('Second sentence.')(Buffer.from('two')); await second;
  assert.equal(sent.length, 0);
  ready.get('First sentence.')(Buffer.from('one')); await first;
  assert.equal(sent.length, 1);
  speech.played({ id: sent[0].id, playing: true });
  assert.equal(sent.length, 1);
  speech.played({ id: sent[0].id, playing: false });
  assert.deepEqual(sent.map(m => m.text), ['First sentence.', 'Second sentence.']);
});

test('new action cues cancel stale synthesis and stale acknowledgements', async t => {
  const sent = [];
  let resolve;
  const speech = new ReplySpeech({ synth: () => new Promise(r => { resolve = r; }), deliver: m => sent.push(m), stopped() {}, warning() {} });
  t.after(() => speech.cancel());
  const stale = speech.add('An old step.');
  speech.cancel(); await speech.add('Tapping here.', { local: true });
  resolve(Buffer.from('old')); await stale;
  assert.deepEqual(sent.map(m => m.text), ['Tapping here.']);
  const id = speech.current.id;
  speech.played({ id: 'stale', playing: false });
  assert.equal(speech.current.id, id);
});
