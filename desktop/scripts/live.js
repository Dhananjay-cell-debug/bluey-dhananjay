'use strict';
// Drives the running source-built Bluey for QA: node scripts/live.js status | ask "..." | tool phone_look '{}' | greet | wake | sleep
const fs = require('fs');
const path = require('path');
const http = require('http');
const file = path.join(process.env.APPDATA, 'Bluey', 'dev-control.json');
const { port, secret } = JSON.parse(fs.readFileSync(file, 'utf8'));
function post(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request({ host: '127.0.0.1', port, path: url, method: 'POST', headers: { 'x-bluey-secret': secret, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(b); } });
    });
    req.on('error', reject); req.end(data);
  });
}
(async () => {
  const [cmd, a, b] = process.argv.slice(2);
  let out;
  if (cmd === 'status') out = await post('/companion/status');
  else if (cmd === 'tool') out = await post('/tools/call', { name: a, arguments: b ? JSON.parse(b) : {} });
  else if (['wake', 'greet', 'sleep'].includes(cmd)) out = await post('/companion/check', { action: cmd });
  else if (cmd === 'ask') out = await post('/companion/check', { action: 'ask', text: a });
  else throw new Error('status | ask "text" | tool name [json] | wake | greet | sleep');
  if (out && out.content) out = out.content.map((c) => c.type === 'text' ? c.text : '[image]').join('\n');
  console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e.message); process.exit(1); });
