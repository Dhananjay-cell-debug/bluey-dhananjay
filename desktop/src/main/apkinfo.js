'use strict';
const fs = require('fs');
const crypto = require('crypto');

/** What the phone needs to know about the Bluey.apk this PC serves: version (from the sidecar), size and SHA-256. */
let cache = null;
function apkInfo(apk) {
  try {
    const st = fs.statSync(apk);
    if (cache && cache.apk === apk && cache.mtime === st.mtimeMs && cache.size === st.size) return cache.info;
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(apk)).digest('hex');
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(apk.replace(/\.apk$/i, '.json'), 'utf8')); } catch {}
    const info = { versionCode: Number(meta.versionCode) || 0, versionName: String(meta.versionName || ''), size: st.size, sha256 };
    cache = { apk, mtime: st.mtimeMs, size: st.size, info };
    return info;
  } catch { return null; }
}
module.exports = { apkInfo };
