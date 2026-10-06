// Bluey's brain on a Claude subscription: one long-lived Claude Code process in streaming JSON mode.
// Only Bluey's own tools are enabled (through the MCP bridge); Claude Code's coding tools are switched off,
// and API keys are stripped from its environment so it always runs on the claude.ai login.
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { EventEmitter } = require('events');
const locate = require('./locate');

const MODELS = { fast: 'haiku', balanced: 'sonnet', smart: 'opus' };

function subscriptionEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_MODEL']) delete env[key];
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  env.DISABLE_AUTOUPDATER = '1';
  return env;
}

class ClaudeBrain extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.instructions system prompt
   * @param {string[]} o.toolNames Bluey tool names to allow
   * @param {object} o.bridge {command, args, env} to start the MCP bridge
   * @param {string} o.workDir scratch folder for config files
   * @param {string} o.speed fast | balanced | smart
   */
  constructor(o) {
    super();
    this.o = o;
    this.proc = null;
    this.busy = false;
    this.text = '';
    this.freshMessage = true;
    this.ready = false;
    this.name = 'claude';
  }

  start() {
    const tool = locate.findClaude();
    if (!tool) throw new Error("Claude Code isn't installed. Install it, then sign in with your Claude subscription (claude auth login).");
    fs.mkdirSync(this.o.workDir, { recursive: true });
    const mcpFile = path.join(this.o.workDir, 'claude-mcp.json');
    fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { bluey: { type: 'stdio', ...this.o.bridge } } }, null, 2));
    const promptFile = path.join(this.o.workDir, 'claude-system-prompt.txt');
    fs.writeFileSync(promptFile, this.o.instructions);
    const allowed = this.o.toolNames.map((n) => 'mcp__bluey__' + n).join(',');
    const args = [...tool.prefix,
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--system-prompt-file', promptFile,
      '--mcp-config', mcpFile, '--strict-mcp-config',
      '--tools', '', '--allowedTools', allowed,
      '--model', this.o.model || MODELS[this.o.speed] || 'sonnet',
      '--setting-sources', '', '--no-session-persistence', '--disable-slash-commands',
    ];
    const effort = this.o.effort || ((this.o.speed || 'balanced') === 'smart' ? '' : 'low');
    if (effort) args.push('--effort', effort);
    this.currentModel = this.o.model || MODELS[this.o.speed] || 'sonnet';
    this.currentEffort = effort || null;
    this.proc = spawn(tool.command, args, {
      cwd: this.o.workDir, env: subscriptionEnv(tool.node ? { ELECTRON_RUN_AS_NODE: '1' } : {}), windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.stderr = '';
    this.proc.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-4000); });
    this.proc.on('error', (e) => this.fail('Claude Code could not start: ' + e.message));
    this.proc.on('exit', (code) => {
      const was = this.proc;
      this.proc = null;
      this.ready = false;
      if (this.busy) this.finishTurn('', this.explainExit(code));
      this.emit('exit', { code, stderr: this.stderr, expected: was && was.expectedExit });
    });
    readline.createInterface({ input: this.proc.stdout }).on('line', (line) => this.onLine(line));
    this.proc.stdin.on('error', () => {});
  }

  explainExit(code) {
    const err = this.stderr.toLowerCase();
    if (/not logged in|login|authenticat|401/.test(err)) return "Claude isn't signed in. Run `claude auth login` with your Claude subscription.";
    if (/rate limit|usage limit|limit reached/.test(err)) return "You've hit your Claude plan's usage limit for now.";
    return `Claude Code stopped (code ${code}). ${this.stderr.split('\n').filter(Boolean).slice(-1)[0] || ''}`.trim();
  }

  fail(message) {
    if (this.busy) this.finishTurn('', message);
    else this.emit('error', message);
  }

  write(obj) {
    if (!this.proc) return false;
    try { this.proc.stdin.write(JSON.stringify(obj) + '\n'); return true; } catch { return false; }
  }

  /** Changes the model and effort for the next questions, without restarting (Claude Code accepts this mid-session). */
  configure({ model, effort }) {
    if (!this.proc) return;
    if (model && model !== this.currentModel) { this.write({ type: 'control_request', request_id: 'm' + Date.now(), request: { subtype: 'set_model', model } }); this.currentModel = model; }
    if (effort && effort !== this.currentEffort) { this.write({ type: 'control_request', request_id: 'e' + Date.now(), request: { subtype: 'apply_flag_settings', settings: { effortLevel: effort } } }); this.currentEffort = effort; }
  }

  /** Sends one user message (text, optionally with images as {mime, base64}). */
  ask(text, images = []) {
    if (!this.proc) this.start();
    if (this.busy) this.interrupt();
    this.busy = true;
    this.outstanding = (this.outstanding || 0) + 1;  // each message gets exactly one result, in order
    this.text = '';
    this.lastReply = '';
    this.freshMessage = true;
    this.turnStarted = Date.now();
    const content = [{ type: 'text', text }];
    for (const img of images) content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.base64 } });
    this.write({ type: 'user', message: { role: 'user', content } });
    this.emit('turnStart');
  }

  interrupt() {
    if (!this.busy) return;
    this.write({ type: 'control_request', request_id: 'int-' + Date.now(), request: { subtype: 'interrupt' } });
    this.finishTurn(this.lastReply, null, true);
  }

  finishTurn(text, error, interrupted) {
    if (!this.busy) return;
    this.busy = false;
    this.emit('turnEnd', { text: text || this.lastReply || '', error, interrupted: !!interrupted, ms: Date.now() - this.turnStarted });
  }

  onLine(line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          this.ready = true;
          const bluey = (m.mcp_servers || []).find((s) => s.name === 'bluey');
          if (bluey && bluey.status !== 'connected') this.emit('error', "Bluey's tools didn't connect to Claude (" + bluey.status + ').');
          this.emit('ready', { model: m.model });
        }
        break;
      case 'rate_limit_event': {
        // How much of the plan's usage window is used, straight from Claude Code.
        const info = m.rate_limit_info || {};
        const five = (info.unifiedWindows && info.unifiedWindows.five_hour) || {};
        const week = (info.unifiedWindows && info.unifiedWindows.seven_day) || {};
        this.emit('usage', { plan: 'Claude', fiveHour: five.utilization, week: week.utilization, resetsAt: five.resetsAt || info.resetsAt, status: info.status });
        break;
      }
      case 'stream_event': {
        if (!this.busy || this.outstanding > 1) break;  // still flushing an interrupted turn
        const e = m.event || {};
        if (e.type === 'message_start') this.freshMessage = true;
        else if (e.type === 'content_block_start' && e.content_block && e.content_block.type === 'tool_use') {
          this.emit('toolStart', { name: String(e.content_block.name || '').replace(/^mcp__bluey__/, '') });
        } else if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta') {
          if (this.freshMessage) { this.text = ''; this.freshMessage = false; }
          this.text += e.delta.text;
          this.emit('text', this.text);
        }
        break;
      }
      case 'assistant': {
        if (!this.busy || this.outstanding > 1) break;
        if (m.message && m.message.model && m.message.model !== '<synthetic>') { this.lastModel = m.message.model; this.emit('modelUsed', m.message.model); }
        const parts = (m.message && m.message.content) || [];
        const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('').trim();
        if (text) { this.lastReply = text; this.emit('reply', text); }
        break;
      }
      case 'result':
        this.outstanding = Math.max(0, (this.outstanding || 0) - 1);
        if (this.outstanding > 0) break;  // that was the interrupted turn's result
        if (m.is_error || (m.subtype && m.subtype !== 'success')) {
          const why = String(m.result || m.subtype || 'error');
          this.finishTurn('', /limit/i.test(why) ? "You've hit your Claude plan's usage limit for now." : 'Claude had a problem: ' + why.slice(0, 160));
        } else {
          this.finishTurn(String(m.result || '').trim() || this.lastReply);
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
    setTimeout(() => { try { p.kill(); } catch {} }, 1500);
  }
}

/** What a Claude subscription offers through Claude Code (aliases always point at the latest of each). */
const CHOICES = {
  models: [
    { id: 'opus', name: 'Opus, always the newest (very smart)' },
    { id: 'fable', name: 'Fable, always the newest (needs a Max plan or extra credits)' },
    { id: 'sonnet', name: 'Sonnet, always the newest (smart and quick)' },
    { id: 'haiku', name: 'Haiku, always the newest (fastest)' },
  ],
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
};

module.exports = { ClaudeBrain, MODELS, CHOICES, subscriptionEnv };
