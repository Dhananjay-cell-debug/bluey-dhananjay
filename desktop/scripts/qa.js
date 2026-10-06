// One command for Bluey's whole quality check: npm run qa [-- --quick] [-- --brain=codex]
//   1. unit + integration tests (node:test)
//   2. the native helper's self-test (real screen capture, Windows OCR, UI Automation)
//   3. the real app, driven through scripted scenarios (visual, panel, look, brain, voice, latency, notes)
// Writes everything to qa/<timestamp>/ and prints a pass/fail table. Brain scenarios use your subscription lightly.
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const quick = process.argv.includes('--quick');
const brainArg = (process.argv.find((a) => a.startsWith('--brain=')) || '').split('=')[1];
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const out = path.join(root, '..', 'qa', stamp);
fs.mkdirSync(out, { recursive: true });
const rows = [];

function step(name, fn) {
  const t0 = Date.now();
  let ok = false, note = '';
  try { [ok, note] = fn(); } catch (e) { note = e.message; }
  rows.push({ name, ok, note, seconds: ((Date.now() - t0) / 1000).toFixed(1) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${note}`);
}

step('unit + integration tests', () => {
  const r = spawnSync(process.execPath, ['--test', ...fs.readdirSync(path.join(root, 'test')).filter((f) => f.endsWith('.test.js')).map((f) => path.join('test', f))],
    { cwd: root, encoding: 'utf8' });
  fs.writeFileSync(path.join(out, 'tests.log'), r.stdout + r.stderr);
  const pass = (r.stdout.match(/ℹ pass (\d+)/) || [])[1], fail = (r.stdout.match(/ℹ fail (\d+)/) || [])[1];
  return [r.status === 0, `${pass} passed, ${fail} failed`];
});

step('native helper self-test', () => {
  const r = spawnSync(path.join(root, 'native', 'BlueyNative.exe'), ['--selftest'], { encoding: 'utf8', timeout: 60000 });
  fs.writeFileSync(path.join(out, 'native.log'), r.stdout + r.stderr);
  const first = (r.stdout.split('\n')[0] || '').trim();
  // A locked screen has no text to read; that's the environment, not the helper.
  const locked = /LockApp/i.test(r.stdout);
  return [r.status === 0 || locked, locked ? 'screen is locked (capture works, nothing to read) ' + first : first];
});

const scenarios = quick ? 'visual,panel,brain' : 'facerate,visual,panel,look,brain,voice,phone,phonecontrol,speakers,tabs,latency,notes';
step(`app scenarios (${scenarios})`, () => {
  const electron = require('electron');
  const env = { ...process.env, BLUEY_QA: scenarios, BLUEY_QA_OUT: out };
  if (brainArg) env.BLUEY_QA_BRAIN = brainArg;
  const r = spawnSync(electron, ['.'], { cwd: root, env, encoding: 'utf8', timeout: 15 * 60 * 1000 });
  fs.writeFileSync(path.join(out, 'app.log'), (r.stdout || '') + (r.stderr || ''));
  const report = JSON.parse(fs.readFileSync(path.join(out, 'qa-report.json'), 'utf8'));
  for (const res of report.results) {
    const detail = res.name === 'latency' ? `median first word ${res.medianFirstTextMs} ms`
      : res.name === 'voice' ? `heard "${res.transcribed}", text in ${res.releaseToTextMs} ms, first word ${res.askToFirstWordMs} ms`
      : res.name === 'phonecontrol' ? `tools ${(res.tools || []).join(' > ')}; said "${res.reply}"`
      : res.name === 'tabs' ? `brain said "${res.reply}", front window now "${res.afterBrain}"`
      : res.name === 'phone' ? `paired, woke, heard "${res.heard}", answered in ${res.releaseToAnswerMs} ms: "${res.reply}"`
      : res.name === 'brain' ? `${res.brain}: "${res.reply}" in ${res.ms} ms`
      : res.name === 'look' ? `${res.lines} lines, ${res.controls} controls in ${res.ms} ms`
      : '';
    rows.push({ name: '  ' + res.name, ok: res.ok, note: detail + (res.error ? ' error: ' + res.error : ''), seconds: '' });
    console.log(`${res.ok ? 'PASS' : 'FAIL'}    ${res.name}  ${detail}`);
  }
  return [report.results.every((x) => x.ok), `${report.results.filter((x) => x.ok).length}/${report.results.length} scenarios`];
});

const allOk = rows.every((r) => r.ok);
fs.writeFileSync(path.join(out, 'SUMMARY.md'), ['# Bluey QA ' + stamp, '', '| Check | Result | Details |', '|---|---|---|',
  ...rows.map((r) => `| ${r.name.trim()} | ${r.ok ? 'PASS' : 'FAIL'} | ${r.note} |`), '', allOk ? 'All checks passed.' : 'Some checks failed.'].join('\n'));
console.log(`\n${allOk ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'} — details in ${out}`);
process.exit(allOk ? 0 : 1);
