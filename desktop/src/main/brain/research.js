// Web research on the subscription: a one-off Claude Code run with only WebSearch/WebFetch,
// or a one-off Codex run with its web search tool. Returns { title, paragraphs, sources }.
'use strict';

const { spawn } = require('child_process');
const locate = require('./locate');
const claude = require('./claude');
const { researchInstructions } = require('../prompts');

function runCapture(command, args, { env, cwd, input, timeout = 180000 }) {
  return new Promise((resolve) => {
    const p = spawn(command, args, { env, cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { try { p.kill(); } catch {} }, timeout);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: err + e.message }); });
    p.on('exit', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    if (input) p.stdin.end(input); else p.stdin.end();
  });
}

/** Pulls the report JSON out of the model's answer (tolerating code fences or extra words). */
function parseReport(text, question) {
  let t = String(text || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1];
  const start = t.indexOf('{'), end = t.lastIndexOf('}');
  let data = null;
  if (start >= 0 && end > start) { try { data = JSON.parse(t.slice(start, end + 1)); } catch {} }
  if (!data) {
    const blocks = String(text || '').split('\n').map((s) => s.trim()).filter(Boolean);
    if (!blocks.length) throw new Error('empty answer');
    data = { title: blocks[0], paragraphs: blocks.slice(1, 5), sources: [] };
  }
  const clean = (s) => String(s || '').replace(/\*\*/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^#+\s*/, '').trim();
  const sources = (Array.isArray(data.sources) ? data.sources : [])
    .filter((s) => s && /^https?:\/\//.test(s.url || ''))
    .map((s) => ({ title: clean(s.title) || new URL(s.url).hostname, url: s.url }))
    .slice(0, 5);
  return {
    question,
    title: clean(data.title) || 'Research',
    paragraphs: (Array.isArray(data.paragraphs) ? data.paragraphs : [String(data.paragraphs || '')]).map(clean).filter(Boolean).slice(0, 4),
    sources,
  };
}

async function viaClaude(question, context, workDir, speed) {
  const tool = locate.findClaude();
  if (!tool) throw new Error('Claude Code is not installed.');
  const prompt = question + (context ? `\n\nWhat's on the user's screen, for context: ${context}` : '');
  const args = [...tool.prefix, '-p', '--output-format', 'json', '--system-prompt', researchInstructions,
    '--tools', 'WebSearch,WebFetch', '--allowedTools', 'WebSearch,WebFetch', '--model', speed === 'smart' ? 'opus' : 'sonnet',
    '--setting-sources', '', '--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands'];
  const r = await runCapture(tool.command, args, { env: claude.subscriptionEnv(tool.node ? { ELECTRON_RUN_AS_NODE: '1' } : {}), cwd: workDir, input: prompt });
  let result;
  try { result = JSON.parse(r.out); } catch { throw new Error((r.err || r.out || 'no answer').trim().split('\n').pop().slice(0, 160)); }
  if (result.is_error) throw new Error(String(result.result || 'research failed').slice(0, 160));
  return parseReport(result.result, question);
}

async function viaCodex(question, context, workDir) {
  const tool = locate.findCodex();
  if (!tool) throw new Error('Codex is not installed.');
  const prompt = researchInstructions + '\n\nQuestion: ' + question + (context ? `\n\nWhat's on the user's screen, for context: ${context}` : '');
  const args = [...tool.prefix, 'exec', '--json', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '-s', 'read-only',
    '-c', 'tools.web_search=true', '-c', 'web_search="live"', '-c', 'model_reasoning_effort="low"',
    '--disable', 'shell_tool', '--disable', 'apps', '--disable', 'browser_use', '--disable', 'computer_use', '-'];
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  if (tool.node) env.ELECTRON_RUN_AS_NODE = '1';
  const r = await runCapture(tool.command, args, { env, cwd: workDir, input: prompt });
  let text = '';
  for (const line of r.out.split('\n')) {
    try {
      const m = JSON.parse(line);
      if (m.type === 'item.completed' && m.item && m.item.type === 'agent_message') text = m.item.text;
    } catch {}
  }
  if (!text) throw new Error((r.err || 'no answer').trim().split('\n').pop().slice(0, 160));
  return parseReport(text, question);
}

async function research(question, { context, brain, workDir, speed }) {
  const first = brain === 'codex' ? viaCodex : viaClaude;
  const second = brain === 'codex' ? viaClaude : viaCodex;
  try {
    return await first(question, context, workDir, speed);
  } catch (e) {
    try { return await second(question, context, workDir, speed); } catch { throw e; }
  }
}

module.exports = { research, parseReport };
