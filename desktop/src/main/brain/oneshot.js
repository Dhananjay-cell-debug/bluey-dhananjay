'use strict';
// A single quiet question to the subscription's model (no tools, nothing saved): used for background work like learning.
const locate = require('./locate');
const claude = require('./claude');
const { runCapture } = require('./research');

async function viaClaude(prompt, { system, workDir }) {
  const tool = locate.findClaude();
  if (!tool) throw new Error('Claude Code is not installed.');
  const args = [...tool.prefix, '-p', '--output-format', 'json', '--system-prompt', system, '--tools', '', '--model', 'sonnet',
    '--setting-sources', '', '--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands'];
  const r = await runCapture(tool.command, args, { env: claude.subscriptionEnv(tool.node ? { ELECTRON_RUN_AS_NODE: '1' } : {}), cwd: workDir, input: prompt, timeout: 120000 });
  let result;
  try { result = JSON.parse(r.out); } catch { throw new Error((r.err || r.out || 'no answer').trim().split('\n').pop().slice(0, 160)); }
  if (result.is_error) throw new Error(String(result.result || 'failed').slice(0, 160));
  return String(result.result || '');
}

async function viaCodex(prompt, { system, workDir }) {
  const tool = locate.findCodex();
  if (!tool) throw new Error('Codex is not installed.');
  const args = [...tool.prefix, 'exec', '--json', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '-s', 'read-only',
    '-c', 'model_reasoning_effort="low"', '--disable', 'shell_tool', '--disable', 'apps', '--disable', 'browser_use', '--disable', 'computer_use', '-'];
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  if (tool.node) env.ELECTRON_RUN_AS_NODE = '1';
  const r = await runCapture(tool.command, args, { env, cwd: workDir, input: system + '\n\n' + prompt, timeout: 120000 });
  let text = '';
  for (const line of r.out.split('\n')) {
    try { const m = JSON.parse(line); if (m.type === 'item.completed' && m.item && m.item.type === 'agent_message') text = m.item.text; } catch {}
  }
  if (!text) throw new Error((r.err || 'no answer').trim().split('\n').pop().slice(0, 160));
  return text;
}

async function oneShot(prompt, { system, brain, workDir }) {
  const first = brain === 'codex' ? viaCodex : viaClaude;
  const second = brain === 'codex' ? viaClaude : viaCodex;
  try { return await first(prompt, { system, workDir }); }
  catch (e) { try { return await second(prompt, { system, workDir }); } catch { throw e; } }
}

module.exports = { oneShot };
