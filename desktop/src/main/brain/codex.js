// Bluey's brain on a ChatGPT subscription: one long-lived `codex app-server` process (JSON-RPC over stdio).
// The thread gets Bluey's instructions as its base instructions, only Bluey's MCP tools, no shell,
// and approvals set to never ask (the tools have their own guardrails). OPENAI_API_KEY is stripped so
// it always runs on the ChatGPT login.
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const readline = require('readline');
const { EventEmitter } = require('events');
const locate = require('./locate');

const EFFORT = { fast: 'low', balanced: 'low', smart: 'medium' };

function subscriptionEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const key of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY']) delete env[key];
  return env;
}

const OFF = ['shell_tool', 'unified_exec', 'apps', 'browser_use', 'browser_use_external', 'computer_use', 'plugins',
  'multi_agent', 'image_generation', 'skill_search', 'tool_suggest', 'goals', 'hooks', 'remote_plugin', 'sleep_tool'];

class CodexBrain extends EventEmitter {
  constructor(o) {
    super();
    this.o = o;
    this.proc = null;
    this.nextId = 1;
    this.waiting = new Map();
    this.threadId = null;
    this.turnId = null;
    this.busy = false;
    this.text = '';
    this.name = 'codex';
  }

  start() {
    const tool = locate.findCodex();
    if (!tool) throw new Error("Codex isn't installed. Install it (npm i -g @openai/codex), then sign in with ChatGPT (codex login).");
    fs.mkdirSync(this.o.workDir, { recursive: true });
    const args = [...tool.prefix, 'app-server', '-c', 'mcp_servers={}'];
    for (const f of OFF) args.push('--disable', f);
    this.proc = spawn(tool.command, args, { cwd: this.o.workDir, env: subscriptionEnv(tool.node ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.stderr = '';
    this.proc.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-4000); });
    this.proc.on('error', (e) => this.fail('Codex could not start: ' + e.message));
    this.proc.on('exit', (code) => {
      const was = this.proc;
      this.proc = null;
      this.threadId = null;
      for (const [, w] of this.waiting) w.reject(new Error('Codex stopped.'));
      this.waiting.clear();
      if (this.busy) this.finishTurn('', `Codex stopped (code ${code}).`);
      this.emit('exit', { code, stderr: this.stderr, expected: was && was.expectedExit });
    });
    this.proc.stdin.on('error', () => {});
    readline.createInterface({ input: this.proc.stdout }).on('line', (line) => this.onLine(line));
    this.starting = this.init().catch((e) => { this.fail(String(e.message || e)); throw e; });
    this.starting.catch(() => {});
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.proc) return reject(new Error('Codex is not running.'));
      const id = this.nextId++;
      this.waiting.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  notify(method, params) {
    if (this.proc) this.proc.stdin.write(JSON.stringify(params ? { method, params } : { method }) + '\n');
  }

  async init() {
    await this.request('initialize', { clientInfo: { name: 'bluey', title: 'Bluey', version: '1.0.0' }, capabilities: null });
    this.notify('initialized');
    const config = {
      'mcp_servers.bluey.command': this.o.bridge.command,
      'mcp_servers.bluey.args': this.o.bridge.args,
      'mcp_servers.bluey.env': this.o.bridge.env,
      'mcp_servers.bluey.default_tools_approval_mode': 'approve',
      'mcp_servers.bluey.tool_timeout_sec': 600,
      'model_reasoning_effort': this.o.effort || EFFORT[this.o.speed] || 'low',
      'tools.web_search': false,
    };
    for (const f of OFF) config['features.' + f] = false;
    const params = { cwd: this.o.workDir, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true,
      baseInstructions: this.o.instructions, config };
    if (this.o.model) params.model = this.o.model;
    const result = await this.request('thread/start', params);
    this.threadId = result.thread.id;
    this.emit('ready', { model: result.model || this.o.model || 'default' });
  }

  /** Model and effort for the next question (Codex takes these on every turn). */
  configure({ model, effort }) { this.turnModel = model || null; this.turnEffort = effort || null; }

  async ask(text, images = []) {
    if (!this.proc) this.start();
    if (this.busy) this.interrupt();
    this.busy = true;
    this.text = '';
    this.lastReply = '';
    this.freshMessage = true;
    this.turnStarted = Date.now();
    this.emit('turnStart');
    try {
      await this.starting;
      const input = [{ type: 'text', text, text_elements: [] }];
      for (const img of images) input.push({ type: 'image', url: `data:${img.mime};base64,${img.base64}` });
      const turn = { threadId: this.threadId, input };
      if (this.turnModel) turn.model = this.turnModel;
      if (this.turnEffort) turn.effort = this.turnEffort;
      const r = await this.request('turn/start', turn);
      this.turnId = r && r.turn && r.turn.id;
    } catch (e) {
      this.finishTurn('', 'Codex had a problem: ' + String(e.message || e).slice(0, 160));
    }
  }

  interrupt() {
    if (!this.busy) return;
    if (this.threadId && this.turnId) this.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }).catch(() => {});
    this.finishTurn(this.lastReply, null, true);
  }

  finishTurn(text, error, interrupted) {
    if (!this.busy) return;
    this.busy = false;
    this.turnId = null;
    this.emit('turnEnd', { text: text || this.lastReply || '', error, interrupted: !!interrupted, ms: Date.now() - this.turnStarted });
  }

  fail(message) {
    if (this.busy) this.finishTurn('', message); else this.emit('error', message);
  }

  onLine(line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.id !== undefined && !m.method) {
      const w = this.waiting.get(m.id);
      if (!w) return;
      this.waiting.delete(m.id);
      if (m.error) w.reject(new Error(m.error.message || JSON.stringify(m.error))); else w.resolve(m.result);
      return;
    }
    if (m.id !== undefined && m.method) {
      // A request from the server (an approval). Bluey's tools are pre-approved; decline anything else.
      const isBluey = JSON.stringify(m.params || {}).includes('bluey');
      this.proc.stdin.write(JSON.stringify({ id: m.id, result: { decision: isBluey ? 'accept' : 'decline' } }) + '\n');
      return;
    }
    const p = m.params || {};
    const current = !this.turnId || !p.turnId || p.turnId === this.turnId;
    switch (m.method) {
      case 'item/started':
        if (!this.busy || !current) break;
        if (p.item && p.item.type === 'agentMessage') this.freshMessage = true;
        if (p.item && p.item.type === 'mcpToolCall') this.emit('toolStart', { name: p.item.tool });
        break;
      case 'item/agentMessage/delta':
        if (!this.busy || !current) break;
        if (this.freshMessage) { this.text = ''; this.freshMessage = false; }
        this.text += p.delta || '';
        this.emit('text', this.text);
        break;
      case 'item/completed':
        if (!this.busy || !current) break;
        if (p.item && p.item.type === 'agentMessage' && (p.item.text || '').trim()) {
          this.lastReply = p.item.text.trim();
          this.emit('reply', this.lastReply);
        }
        break;
      case 'account/rateLimits/updated': {
        const r = p.rateLimits || p;
        const primary = r.primary || {};
        const secondary = r.secondary || {};
        this.emit('usage', { plan: 'ChatGPT', fiveHour: primary.usedPercent != null ? primary.usedPercent / 100 : undefined,
          week: secondary.usedPercent != null ? secondary.usedPercent / 100 : undefined, resetsAt: primary.resetsAt });
        break;
      }
      case 'turn/completed': {
        if (!this.busy || (p.turn && this.turnId && p.turn.id !== this.turnId)) break;
        const err = p.turn && p.turn.error;
        this.finishTurn(this.lastReply, err ? 'Codex had a problem: ' + (err.message || JSON.stringify(err)).slice(0, 160) : null);
        break;
      }
      case 'error':
        if (this.busy && current && p.error && !p.willRetry) {
          const msg = p.error.message || '';
          this.finishTurn('', /limit/i.test(msg) ? "You've hit your ChatGPT plan's usage limit for now." : 'Codex had a problem: ' + msg.slice(0, 160));
        }
        break;
      default:
        break;
    }
  }

  stop() {
    if (!this.proc) return;
    const p = this.proc;
    p.expectedExit = true;
    this.busy = false;
    try { p.stdin.end(); } catch {}
    setTimeout(() => { try { p.kill(); } catch {} }, 1000);
  }
}

/** The models (and the effort levels each supports) that this ChatGPT plan offers, read live from Codex. */
function listModels() {
  return new Promise((resolve) => {
    const tool = locate.findCodex();
    if (!tool) return resolve([]);
    const p = spawn(tool.command, [...tool.prefix, 'app-server'], { env: subscriptionEnv(tool.node ? { ELECTRON_RUN_AS_NODE: '1' } : {}), windowsHide: true });
    let buf = '';
    const done = (list) => { clearTimeout(timer); try { p.kill(); } catch {} resolve(list); };
    const timer = setTimeout(() => done([]), 20000);
    p.on('error', () => done([]));
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) p.stdin.write(JSON.stringify({ id: 2, method: 'model/list', params: {} }) + '\n');
        if (m.id === 2) {
          const items = (m.result && (m.result.data || m.result.models)) || [];
          done(items.map((x) => ({ id: x.id || x.model, name: x.displayName || x.id, isDefault: !!x.isDefault,
            efforts: (x.supportedReasoningEfforts || []).map((e) => e.reasoningEffort || e.effort || e), defaultEffort: x.defaultReasoningEffort })));
        }
      }
    });
    p.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'bluey', title: 'Bluey', version: '1.0.0' }, capabilities: null } }) + '\n');
  });
}

module.exports = { CodexBrain, listModels };
