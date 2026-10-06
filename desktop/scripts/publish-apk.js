'use strict';
// Copies the freshly built phone app to every place people (and the phone's own updater) get it from,
// and writes Bluey.json next to it: the version, size and SHA-256 the PC announces to the phone.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..', '..');
const built = path.join(root, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
const gradle = fs.readFileSync(path.join(root, 'android', 'app', 'build.gradle.kts'), 'utf8');
const versionCode = Number(/versionCode\s*=\s*(\d+)/.exec(gradle)[1]);
const versionName = /versionName\s*=\s*"([^"]+)"/.exec(gradle)[1];
if (!fs.existsSync(built)) throw new Error('Build the app first: ' + built);
const bytes = fs.readFileSync(built);
const meta = { versionCode, versionName, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
const targets = [path.join(root, 'desktop', 'vendor', 'android'), root, path.join(os.homedir(), 'Desktop')];
for (const dir of targets) {
  if (!fs.existsSync(dir)) continue;
  fs.copyFileSync(built, path.join(dir, 'Bluey.apk'));
  if (dir !== path.join(os.homedir(), 'Desktop')) fs.writeFileSync(path.join(dir, 'Bluey.json'), JSON.stringify(meta, null, 2));
}
console.log('published', meta);
