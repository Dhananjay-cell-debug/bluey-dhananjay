// Finds the Claude Code and Codex command-line tools on this PC, and checks they're signed in
// with a subscription (claude.ai / ChatGPT), so Bluey never needs an API key.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

function exists(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

function pathDirs() {
  return (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
}

function npmGlobalDirs() {
  const dirs = [];
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
  dirs.push(...pathDirs().filter((d) => /npm/i.test(d)));
  return [...new Set(dirs)];
}

/** Claude Code: the native claude.exe, or the npm package's cli.js run with Node. */
function findClaude() {
  const candidates = [];
  for (const dir of pathDirs()) candidates.push(path.join(dir, 'claude.exe'));
  candidates.push(path.join(os.homedir(), '.local', 'bin', 'claude.exe'));
  candidates.push(path.join(os.homedir(), '.claude', 'local', 'claude.exe'));
  for (const c of candidates) if (exists(c)) return { command: c, prefix: [] };
  for (const dir of npmGlobalDirs()) {
    const cli = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    if (exists(cli)) return { command: process.execPath, prefix: [cli], node: true };
  }
  return null;
}

/** Codex: the native codex.exe inside the npm package (so no shell is needed), or codex.js run with Node. */
function findCodex() {
  for (const dir of pathDirs()) {
    const exe = path.join(dir, 'codex.exe');
    if (exists(exe)) return { command: exe, prefix: [] };
  }
  for (const dir of npmGlobalDirs()) {
    const base = path.join(dir, 'node_modules', '@openai', 'codex');
    const exe = path.join(base, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
    if (exists(exe)) return { command: exe, prefix: [] };
    const js = path.join(base, 'bin', 'codex.js');
    if (exists(js)) return { command: process.execPath, prefix: [js], node: true };
  }
  return null;
}

function run(tool, args, timeout = 20000) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (tool.node) env.ELECTRON_RUN_AS_NODE = '1';
    execFile(tool.command, [...tool.prefix, ...args], { timeout, env, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout || ''), stderr: String(stderr || ''), error });
    });
  });
}

/** Which brains are installed and signed in, and how. */
async function status() {
  const result = { claude: { installed: false }, codex: { installed: false } };
  const claude = findClaude();
  if (claude) {
    result.claude.installed = true;
    result.claude.path = claude.command;
    const r = await run(claude, ['auth', 'status']);
    try {
      const info = JSON.parse(r.stdout);
      result.claude.loggedIn = !!info.loggedIn;
      result.claude.method = info.authMethod;
      result.claude.subscription = info.authMethod === 'claude.ai';
      result.claude.detail = info.email || info.subscriptionType || '';
    } catch {
      result.claude.loggedIn = /logged in/i.test(r.stdout) && !/not logged/i.test(r.stdout);
    }
  }
  const codex = findCodex();
  if (codex) {
    result.codex.installed = true;
    result.codex.path = codex.command;
    const r = await run(codex, ['login', 'status']);
    const text = (r.stdout + r.stderr).trim();
    result.codex.loggedIn = r.ok && /logged in/i.test(text) && !/not logged/i.test(text);
    result.codex.subscription = /chatgpt/i.test(text);
    result.codex.detail = text.split('\n')[0];
  }
  return result;
}

module.exports = { findClaude, findCodex, status, run };
