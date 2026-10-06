'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { apkInfo } = require('../src/main/apkinfo');
const { PhoneServer } = require('../src/main/phone');

function fakeApk(meta) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluey-apk-'));
  const apk = path.join(dir, 'Bluey.apk');
  const bytes = crypto.randomBytes(2048);
  fs.writeFileSync(apk, bytes);
  fs.writeFileSync(path.join(dir, 'Bluey.json'), JSON.stringify(meta));
  return { apk, sha: crypto.createHash('sha256').update(bytes).digest('hex') };
}

test('the apk announcement carries version, size and the real SHA-256', () => {
  const { apk, sha } = fakeApk({ versionCode: 7, versionName: '1.5.0' });
  assert.deepStrictEqual(apkInfo(apk), { versionCode: 7, versionName: '1.5.0', size: 2048, sha256: sha });
});

test('only a phone with an older version code is offered the update', () => {
  const { apk } = fakeApk({ versionCode: 7, versionName: '1.5.0' });
  const sent = [];
  const server = Object.create(PhoneServer.prototype);
  Object.assign(server, { apk, send: (ws, m) => sent.push(m), emit() {} });
  server.offerUpdate({}, { versionCode: 6 });
  server.offerUpdate({}, { versionCode: 7 });
  server.offerUpdate({}, { versionCode: 0 });  // an app too old to know about updates
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].t, 'update');
  assert.strictEqual(sent[0].versionCode, 7);
  assert.strictEqual(sent[0].path, '/Bluey.apk');
});
