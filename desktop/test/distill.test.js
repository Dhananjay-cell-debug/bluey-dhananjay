'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { Learning } = require('../src/main/learning');
const { distill, transcript, parse } = require('../src/main/distill');

const settings = { get: (k) => (k === 'learningEnabled' ? true : undefined) };
const fresh = () => new Learning(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bluey-learn-')), 'learning.json'), settings);
const session = [
  { kind: 'heard', text: 'somebody in the background said buy milk' },
  { kind: 'asked', text: 'Write the Claude prompt in three parts: context, task, then output format, like always.' },
  { kind: 'reply', text: 'Here it is.' },
  { kind: 'asked', text: 'Shorter answers please, and keep Hinglish.' },
];

test('only the user\'s own questions and Bluey replies reach the learning pass', () => {
  const t = transcript(session);
  assert.strictEqual(t.asked, 2);
  assert.ok(!/milk/.test(t.text));
});

test('a session teaches durable habits, capped at three, with credentials refused', async () => {
  const learning = fresh();
  const answer = JSON.stringify({ items: [
    { kind: 'prompt_style', text: 'Writes Claude prompts as context, task, output format.', evidence: 'three parts' },
    { kind: 'preference', text: 'Likes short answers in Hinglish.', evidence: 'Shorter answers please' },
    { kind: 'preference', text: 'Their api key is sk-123.', evidence: '' },
    { kind: 'workflow', text: 'a fourth', evidence: '' },
  ] });
  const saved = await distill({ entries: session, learning, run: async () => '```json\n' + answer + '\n```' });
  assert.deepStrictEqual(saved.map((s) => s.kind), ['prompt_style', 'preference']);
  assert.ok(saved.every((s) => s.auto && s.source === 'Noticed in a session'));
  assert.match(learning.context('write a claude prompt'), /context, task, output format/);
});

test('short or paused sessions are not mined', async () => {
  const learning = fresh();
  let called = false;
  assert.deepStrictEqual(await distill({ entries: session.slice(0, 2), learning, run: async () => { called = true; return '{}'; } }), []);
  learning.settings = { get: () => false };
  assert.deepStrictEqual(await distill({ entries: session, learning, run: async () => { called = true; return '{}'; } }), []);
  assert.strictEqual(called, false);
  assert.deepStrictEqual(parse('no json here'), []);
});
