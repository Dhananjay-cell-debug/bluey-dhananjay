// A tiny MCP server (stdio, JSON-RPC lines) that Claude Code or Codex starts as a child process.
// It owns no logic: every tools/list and tools/call is forwarded to the running Bluey app over
// localhost HTTP (port and secret come from the environment), so the tools always run in the app.
'use strict';

const http = require('http');
const readline = require('readline');

const PORT = Number(process.env.BLUEY_PORT);
const SECRET = process.env.BLUEY_SECRET || '';

function send(message) { process.stdout.write(JSON.stringify(message) + '\n'); }

function forward(path, body) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body || {}));
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method: 'POST', timeout: 10 * 60 * 1000,
      headers: { 'content-type': 'application/json', 'content-length': data.length, 'x-bluey-secret': SECRET } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { resolve({ error: 'Bad reply from Bluey.' }); }
      });
    });
    req.on('error', (e) => resolve({ error: "Bluey isn't running (" + e.message + ')' }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'Bluey took too long.' }); });
    req.end(data);
  });
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: {
      protocolVersion: (params && params.protocolVersion) || '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'bluey', version: '1.0.0' } } });
  } else if (method === 'tools/list') {
    const reply = await forward('/tools/list');
    send({ jsonrpc: '2.0', id, result: { tools: reply.tools || [] } });
  } else if (method === 'tools/call') {
    const reply = await forward('/tools/call', { name: params.name, arguments: params.arguments || {} });
    if (reply.error && !reply.content) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: reply.error }], isError: true } });
    } else {
      send({ jsonrpc: '2.0', id, result: { content: reply.content, isError: !!reply.isError } });
    }
  } else if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
  } else if (id !== undefined && id !== null) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
  }
});
