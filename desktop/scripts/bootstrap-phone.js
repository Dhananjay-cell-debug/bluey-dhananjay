'use strict';
// Waits for the phone's Bluey (any version) to connect, then asks Bluey to install the newest Bluey.apk on the phone
// using his phone hands, so nobody has to touch the phone. Usage: node scripts/bootstrap-phone.js [minutes]
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { port, secret } = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'Bluey', 'dev-control.json'), 'utf8'));
const post = (url, body) => new Promise((resolve, reject) => {
  const data = JSON.stringify(body || {});
  const req = http.request({ host: '127.0.0.1', port, path: url, method: 'POST', headers: { 'x-bluey-secret': secret, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
    let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(b); } });
  });
  req.on('error', reject); req.end(data);
});
const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal && a.address.startsWith('192.168.')).address;
const meta = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vendor', 'android', 'Bluey.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const until = Date.now() + (Number(process.argv[2]) || 30) * 60000;
  console.log('waiting for the phone…');
  while (Date.now() < until) {
    const s = await post('/companion/status').catch(() => null);
    const phone = s && s.phones && s.phones.find((p) => p.hands);
    if (phone) {
      console.log('phone connected, version', phone.version);
      if (phone.version && phone.version >= meta.versionName) return console.log('already up to date');
      const url = `http://${lan}:${port === 0 ? 47613 : 47613}/Bluey.apk`;
      const task = `On my phone, install the newest Bluey app from this link: ${url}. Open it in the phone's browser, download the file, then open the downloaded file and press Install or Update. If Android asks to allow installs from the browser, allow it. Keep going until it says the app is installed (the Bluey app will restart). If a warning screen appears about harmful files, describe it before continuing. Do not touch anything else.`;
      console.log(JSON.stringify(await post('/companion/check', { action: 'ask', text: task })));
      return;
    }
    await sleep(3000);
  }
  console.log('phone never connected');
})();
