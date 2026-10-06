// Natural neural voices: the free "Read aloud" voices Microsoft Edge uses (Ava, Jenny, Aria, Neerja, Swara…).
// No account and no API key. The text of his reply is sent to Microsoft's speech service to be turned into audio,
// so this needs internet; with no connection Bluey falls back to the Windows voice on this PC.
'use strict';

const crypto = require('crypto');
const WebSocket = require('ws');

const TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROME_VERSION = '143.0.3650.75';
const ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';
const WIN_EPOCH = 11644473600;

let clockSkew = 0;  // seconds; corrected from the server's Date header if the PC's clock is off
const cache = new Map();

/** The time-based token Microsoft's endpoint checks (SHA-256 of a 5-minute-rounded Windows timestamp + the client token). */
function secMsGec(nowMs = Date.now()) {
  let seconds = Math.floor(nowMs / 1000) + clockSkew + WIN_EPOCH;
  seconds -= seconds % 300;
  const ticks = BigInt(seconds) * 10000000n;
  return crypto.createHash('sha256').update(`${ticks}${TOKEN}`, 'ascii').digest('hex').toUpperCase();
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const uuid = () => crypto.randomUUID().replace(/-/g, '');

/** Speaks `text` with a neural voice; resolves with an MP3 (24 kHz) Buffer. rate like '+10%'. */
function synthUncached(text, { voice = 'en-US-AvaMultilingualNeural', rate = '+4%', pitch = '+0Hz', timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TOKEN}`
      + `&ConnectionId=${uuid()}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=1-${CHROME_VERSION}`;
    const ws = new WebSocket(url, { headers: { Origin: ORIGIN, 'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION.split('.')[0]}.0.0.0 Safari/537.36 Edg/${CHROME_VERSION.split('.')[0]}.0.0.0`,
      'Accept-Encoding': 'gzip, deflate, br', 'Accept-Language': 'en-US,en;q=0.9', Pragma: 'no-cache', 'Cache-Control': 'no-cache' } });
    const chunks = [];
    const timer = setTimeout(() => { try { ws.terminate(); } catch {} reject(new Error('speech service timed out')); }, timeout);
    const stamp = () => new Date().toUTCString().replace('GMT', 'GMT+0000 (Coordinated Universal Time)');
    ws.on('unexpected-response', (req, res) => {
      clearTimeout(timer);
      if (res.statusCode === 403 && res.headers.date) clockSkew = Math.round((Date.parse(res.headers.date) - Date.now()) / 1000);  // fix a wrong PC clock for next time
      reject(new Error('speech service said ' + res.statusCode));
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
    ws.on('close', () => { clearTimeout(timer); reject(new Error('speech connection closed before audio completed')); });
    ws.on('open', () => {
      ws.send(`X-Timestamp:${stamp()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n`
        + JSON.stringify({ context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' }, outputFormat: 'audio-24khz-48kbitrate-mono-mp3' } } } }));
      const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${voice}'><prosody pitch='${pitch}' rate='${rate}' volume='+0%'>${esc(text)}</prosody></voice></speak>`;
      ws.send(`X-RequestId:${uuid()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${stamp()}Z\r\nPath:ssml\r\n\r\n${ssml}`);
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (data.length < 2) return;
        const headerLen = data.readUInt16BE(0);
        if (headerLen + 2 > data.length) return;
        const header = data.subarray(2, 2 + headerLen).toString('utf8');
        if (/Path:audio/.test(header)) chunks.push(data.subarray(2 + headerLen));
      } else if (/Path:turn\.end/.test(data.toString())) {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        const audio = Buffer.concat(chunks);
        audio.length ? resolve(audio) : reject(new Error('no audio came back'));
      }
    });
  });
}

async function synth(text, options = {}) {
  const key = JSON.stringify([text, options.voice || 'en-US-AvaMultilingualNeural', options.rate || '+4%', options.pitch || '+0Hz']);
  if (cache.has(key)) return cache.get(key);
  const audio = await synthUncached(text, options);
  if (cache.size >= 48) cache.delete(cache.keys().next().value);
  cache.set(key, audio);
  return audio;
}

/** Voices worth offering: natural female voices first. */
const VOICES = [
  { id: 'en-US-AvaMultilingualNeural', name: 'Ava — warm and natural', lang: 'en-US' },
  { id: 'en-US-EmmaMultilingualNeural', name: 'Emma — soft and friendly', lang: 'en-US' },
  { id: 'en-US-JennyNeural', name: 'Jenny — friendly', lang: 'en-US' },
  { id: 'en-US-AriaNeural', name: 'Aria — expressive, the closest to a ChatGPT-style voice (default)', lang: 'en-US' },
  { id: 'en-IN-NeerjaExpressiveNeural', name: 'Neerja — Indian English, expressive', lang: 'en-IN' },
  { id: 'en-IN-NeerjaNeural', name: 'Neerja — Indian English', lang: 'en-IN' },
  { id: 'hi-IN-SwaraNeural', name: 'Swara — Hindi', lang: 'hi-IN' },
  { id: 'en-GB-SoniaNeural', name: 'Sonia — British', lang: 'en-GB' },
];

module.exports = { synth, secMsGec, VOICES };
