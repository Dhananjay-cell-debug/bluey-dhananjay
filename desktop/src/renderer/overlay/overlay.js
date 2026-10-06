// The big blueberry cursor, drawn every frame on a transparent, click-through window over the screen.
// Motion lives in CursorEngine (common/engine.js); this file draws it, plus the comet trail, the string to
// the phone, little effects (rings, stars, typed letters, labels) and his speech bubble.
'use strict';

const { CursorEngine } = window.BlueyEngine;
const P = window.BlueyPalette;

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
let settings = { cursorSize: 72, phonePosition: 0.5, glow: false, showCursor: true, trail: 'comet', mood: 'listening' };
const engine = new CursorEngine(settings);
let mouse = { x: 0, y: 0 };
let W = window.innerWidth, H = window.innerHeight, DPR = window.devicePixelRatio || 1;
const clock = () => performance.now() / 1000;

function resize() {
  W = window.innerWidth; H = window.innerHeight; DPR = window.devicePixelRatio || 1;
  canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  bodyArt = null;
  if (caption) layoutCaption(caption, true);
}
window.addEventListener('resize', resize);

// ───────────── The body, drawn once into an offscreen canvas ─────────────

function teardrop(c, s, r) {
  const big = s / 2;
  c.beginPath();
  c.moveTo(r, 0);
  c.arcTo(s, 0, s, s, big);
  c.arcTo(s, s, 0, s, big);
  c.arcTo(0, s, 0, 0, big);
  c.arcTo(0, 0, s, 0, r);
  c.closePath();
}

function starPath(c, radius) {
  c.beginPath();
  for (let i = 0; i < 8; i++) {
    const r = i % 2 === 0 ? radius : radius * 0.4;
    const a = i * Math.PI / 4 - Math.PI / 2;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
  }
  c.closePath();
}

let bodyArt = null;
function buildBody() {
  const side = engine.size, glow = settings.glow;
  if (bodyArt && bodyArt.side === side && bodyArt.glow === glow && bodyArt.dpr === DPR) return bodyArt;
  const k = side / 96, pad = side * 0.45;
  const off = document.createElement('canvas');
  off.width = Math.ceil((side + pad * 2) * DPR); off.height = off.width;
  const c = off.getContext('2d');
  c.scale(DPR, DPR);
  c.translate(pad, pad);
  // Soft glow (or shadow) under a white rim.
  c.save();
  c.shadowColor = glow ? P.rgba(P.berry2, 0.7) : P.rgba(P.berry4, 0.45);
  c.shadowBlur = (glow ? 30 : 16) * k;
  teardrop(c, side, 6 * k);
  c.fillStyle = '#fff';
  c.fill();
  c.restore();
  // Blueberry gradient, a soft shine, and the white rim.
  c.save();
  teardrop(c, side, 6 * k);
  c.clip();
  const g = c.createLinearGradient(0.25 * side, 0.067 * side, 0.75 * side, 0.933 * side);
  P.gradient.forEach((hex, i) => g.addColorStop(P.gradientStops[i], hex));
  c.fillStyle = g;
  c.fillRect(-2, -2, side + 4, side + 4);
  const shine = c.createRadialGradient(0.3 * side, 0.24 * side, 0, 0.3 * side, 0.24 * side, 0.38 * side);
  shine.addColorStop(0, 'rgba(255,255,255,0.55)');
  shine.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = shine;
  c.fillRect(-2, -2, side + 4, side + 4);
  teardrop(c, side, 6 * k);
  c.strokeStyle = '#fff';
  c.lineWidth = 8 * k;  // half is clipped away, leaving a 4 pt rim
  c.stroke();
  c.restore();
  bodyArt = { canvas: off, side, glow, dpr: DPR, pad };
  return bodyArt;
}

// ───────────── Effects (fire and forget) ─────────────

const effects = [];
const ease = {
  out: (t) => 1 - Math.pow(1 - t, 3),
  ring: (t) => cubic(0.2, 0.7, 0.3, 1, t),
  star: (t) => cubic(0.1, 0.8, 0.3, 1, t),
};
const curveCache = new Map();
function cubic(x1, y1, x2, y2, t) {
  const key = x1 + ',' + y1 + ',' + x2 + ',' + y2;
  let c = curveCache.get(key);
  if (!c) { c = new window.BlueyEngine.TimingCurve(x1, y1, x2, y2); curveCache.set(key, c); }
  return c.value(t);
}

function ring(point, radius, color, alpha, duration) {
  effects.push({ kind: 'ring', x: point.x, y: point.y, radius, color, alpha, born: clock(), life: duration });
}

function star(point, radius, travel, color, duration) {
  effects.push({ kind: 'star', x: point.x, y: point.y, radius, travel, color, born: clock(), life: duration,
    spin: (Math.random() * 5 - 2.5) });
}

function twinkle(point) {
  star(point, 3 + Math.random() * 2.5, { x: Math.random() * 16 - 8, y: -(6 + Math.random() * 12) },
    Math.random() < 0.5 ? P.berry1 : P.berry2, 0.5);
}

/** Landing on something it's pointing at: a soft ring and a tiny nod. */
engine.onLand = (point) => {
  engine.press(0.05, clock());
  ring(point, 30, P.berry2, 0.55, 0.7);
};

/** Popping out of (or diving back into) the phone at the bottom edge. */
engine.onLaunch = (point) => {
  if (!settings.showCursor) return;
  ring(point, 26, P.berry1, 0.6, 0.55);
  for (let i = 0; i < 3; i++) {
    const dx = (i - 1) * 14;
    star({ x: point.x + dx, y: point.y - 4 }, 4, { x: dx * 0.6, y: -28 }, P.berry1, 0.6);
  }
};

/** A real click: a firm squish, a ring and a little burst of stars. */
function clickEffect(point, right) {
  engine.press(0.14, clock());
  ring(point, 38, right ? P.berry3 : P.berry2, 0.85, 0.65);
  effects.push({ kind: 'ring', x: point.x, y: point.y, radius: 48, color: P.berry1, alpha: 0.5, born: clock() + 0.08, life: 0.78 });
  for (let i = 0; i < 12; i++) {
    const a = i / 12 * 2 * Math.PI + (Math.random() * 0.5 - 0.25);
    const distance = 38 + Math.random() * 40;
    star(point, 4 + Math.random() * 3, { x: Math.cos(a) * distance, y: Math.sin(a) * distance },
      [P.berry1, P.berry2, P.berry3, '#ffffff'][Math.floor(Math.random() * 4)], 0.74);
  }
}

/** A typed character floating up from the cursor, so you can see him typing. */
function typedEffect(text) {
  if (!settings.showCursor || engine.opacity < 0.1) return;
  engine.press(0.035, clock());
  [...text].forEach((ch, i) => {
    if (/\s/.test(ch)) return;
    const start = { x: engine.tip.x + engine.size * 0.55 + i * 6, y: engine.tip.y - 6 };
    effects.push({ kind: 'glyph', ch, x: start.x, y: start.y, dx: Math.random() * 28 - 12, born: clock(), life: 0.9 });
  });
}

/** A little label that pops up next to the cursor, like "Ctrl+T" or "Opening Chrome". The newest replaces older ones. */
let label = null;
function bubble(text, life) {
  if (!settings.showCursor) return;
  ctx.font = `700 19px Fredoka, "Segoe UI", sans-serif`;
  const w = Math.ceil(ctx.measureText(text).width) + 28;
  label = { text, width: w, height: 19 + 16, born: clock(), life: life || 1.4 };
}

function drawEffects(now) {
  for (let i = effects.length - 1; i >= 0; i--) {
    const e = effects[i];
    const t = (now - e.born) / e.life;
    if (t >= 1) { effects.splice(i, 1); continue; }
    if (t < 0) continue;
    ctx.save();
    if (e.kind === 'ring') {
      const p = ease.ring(t);
      const scale = 0.3 + 0.7 * p;
      ctx.globalAlpha = 1 - p;
      ctx.strokeStyle = P.rgba(e.color, e.alpha);
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.radius * scale, 0, Math.PI * 2);
      ctx.stroke();
    } else if (e.kind === 'star') {
      const p = ease.star(t);
      ctx.globalAlpha = t < 0.45 ? 1 : 1 - (t - 0.45) / 0.55;
      ctx.translate(e.x + e.travel.x * p, e.y + e.travel.y * p);
      ctx.rotate(e.spin * t);
      const s = 1 - 0.6 * t;
      ctx.scale(s, s);
      starPath(ctx, e.radius);
      ctx.fillStyle = e.color;
      ctx.fill();
    } else if (e.kind === 'glyph') {
      const p = ease.out(t);
      ctx.globalAlpha = t < 0.12 ? t / 0.12 : t < 0.55 ? 1 : 1 - (t - 0.55) / 0.45;
      ctx.translate(e.x + e.dx * p, e.y - 46 * p);
      const s = 1.1 - 0.35 * t;
      ctx.scale(s, s);
      ctx.font = `700 22px Fredoka, "Segoe UI", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 5;
      ctx.strokeStyle = '#fff';
      ctx.strokeText(e.ch, 0, 0);
      ctx.fillStyle = P.berry3;
      ctx.fillText(e.ch, 0, 0);
    }
    ctx.restore();
  }
}

function drawLabel(now) {
  if (!label) return;
  const age = now - label.born;
  if (age > label.life) { label = null; return; }
  let anchor;
  if (engine.opacity > 0.1) anchor = { x: engine.tip.x + engine.size * 1.05, y: engine.tip.y - engine.size * 0.1 };
  else anchor = { x: W * settings.phonePosition, y: H - engine.size * 1.3 };
  if (anchor.x + label.width > W - 12) anchor.x = engine.opacity > 0.1 ? engine.tip.x - label.width - engine.size * 0.3 : W - label.width - 12;
  const y = anchor.y - Math.min(age, 0.3) * 20;
  const pop = spring(age, 0.4, 11, 160, 6);
  ctx.save();
  ctx.globalAlpha = Math.min(1, age / 0.12, (label.life - age) / 0.3);
  ctx.translate(anchor.x + label.width / 2, y);
  ctx.scale(pop, pop);
  roundRect(ctx, -label.width / 2, -label.height / 2, label.width, label.height, 14);
  ctx.fillStyle = P.rgba(P.ink, 0.92);
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = P.rgba(P.berry2, 0.9);
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.font = `700 19px Fredoka, "Segoe UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label.text, 0, 1);
  ctx.restore();
}

/** A damped spring from `from` to 1 (like CASpringAnimation), evaluated at time t. */
function spring(t, from, damping, stiffness, velocity) {
  const w0 = Math.sqrt(stiffness), zeta = damping / (2 * w0);
  const x0 = from - 1;
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    const B = (zeta * w0 * x0 - velocity) / wd;
    return 1 + Math.exp(-zeta * w0 * t) * (x0 * Math.cos(wd * t) + B * Math.sin(wd * t));
  }
  return 1 + (x0 + (w0 * x0 - velocity) * t) * Math.exp(-w0 * t);
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

// ───────────── Trail and string ─────────────

const samples = [];
let lastTwinkle = 0;
function drawTrail(now, speed, visible) {
  const center = engine.bodyCenter;
  samples.push({ x: center.x, y: center.y, t: now });
  while (samples.length && now - samples[0].t > 0.2) samples.shift();
  if (!visible || settings.trail !== 'comet' || samples.length <= 2 || speed <= 260) return;
  // A soft tapered comet tail along the path it just flew.
  const head = engine.size * 0.42;
  const left = [], right = [];
  for (let i = 0; i < samples.length; i++) {
    const p = samples[i], prev = samples[Math.max(0, i - 1)], next = samples[Math.min(samples.length - 1, i + 1)];
    let n = { x: -(next.y - prev.y), y: next.x - prev.x };
    const length = Math.max(Math.hypot(n.x, n.y), 0.001);
    n = { x: n.x / length, y: n.y / length };
    const w = head * Math.pow(i / (samples.length - 1), 1.3) / 2;
    left.push({ x: p.x + n.x * w, y: p.y + n.y * w });
    right.push({ x: p.x - n.x * w, y: p.y - n.y * w });
  }
  ctx.save();
  ctx.globalAlpha = Math.min(1, (speed - 260) / 900) * 0.26 * engine.opacity;
  ctx.fillStyle = P.berry2;
  ctx.beginPath();
  [...left, ...right.reverse()].forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  if (speed > 900 && now - lastTwinkle > 0.05) {
    lastTwinkle = now;
    twinkle({ x: center.x + Math.random() * 20 - 10, y: center.y + Math.random() * 20 - 10 });
  }
}

let stringMid = null, stringVel = { x: 0, y: 0 };
function drawString(now, dt, visible) {
  if (!visible || settings.trail !== 'string' || engine.opacity <= 0.02) { stringMid = null; return; }
  // Like a balloon string held by the phone: it trails behind with a little slack and sway.
  const from = { x: W * settings.phonePosition, y: H + 4 };
  const to = engine.bodyCenter;
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const slack = Math.max(0, 160 - distance * 0.12);
  const goal = { x: (from.x + to.x) / 2 + Math.sin(now * 1.3) * 6, y: (from.y + to.y) / 2 + slack };
  const mid = stringMid || { ...goal };
  const k = 22;
  stringVel.x += (k * (goal.x - mid.x) - 2 * Math.sqrt(k) * 0.55 * stringVel.x) * dt;
  stringVel.y += (k * (goal.y - mid.y) - 2 * Math.sqrt(k) * 0.55 * stringVel.y) * dt;
  mid.x += stringVel.x * dt; mid.y += stringVel.y * dt;
  stringMid = mid;
  const control = { x: 2 * mid.x - (from.x + to.x) / 2, y: 2 * mid.y - (from.y + to.y) / 2 };
  ctx.save();
  ctx.globalAlpha = engine.opacity;
  ctx.strokeStyle = P.rgba(P.berry1, 0.7);
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.quadraticCurveTo(control.x, control.y, to.x, to.y);
  ctx.stroke();
  ctx.restore();
}

// ───────────── The cursor ─────────────

let look = { x: -0.7, y: -0.7 };
function drawCursor(now, dt, visible) {
  const art = buildBody();
  const k = engine.size / 96;
  const v = engine.velocity;
  const speed = Math.hypot(v.x, v.y);
  // Its eyes look where it's heading, and back at the tip when it stops. They blink now and then.
  let want = { x: -0.7, y: -0.7 };
  if (speed > 90) {
    const a = -engine.angle;
    const local = { x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a) };
    const n = Math.max(Math.hypot(local.x, local.y), 1);
    want = { x: local.x / n, y: local.y / n };
  }
  const follow = Math.min(1, dt * 12);
  look = { x: look.x + (want.x - look.x) * follow, y: look.y + (want.y - look.y) * follow };
  if (!visible || engine.opacity < 0.01) return;

  const squish = engine.pressScale(now);
  ctx.save();
  ctx.globalAlpha = engine.opacity;
  ctx.translate(engine.tip.x, engine.tip.y + engine.hover(now));
  ctx.rotate(engine.angle);
  ctx.scale(squish, squish);
  ctx.drawImage(art.canvas, -art.pad, -art.pad, art.canvas.width / DPR, art.canvas.height / DPR);
  const blinking = now < engine.blinkUntil;
  for (let i = 0; i < 2; i++) {
    const d = 18 * k;
    const cx = (34 + i * 24) * k + d / 2, cy = 40 * k + d / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, blinking ? 0.12 : 1);
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(0, 0, d / 2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = P.ink;
    ctx.beginPath(); ctx.arc(look.x * 3.4 * k, look.y * 3.4 * k, 4.5 * k, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

// ───────────── Speech bubble ─────────────

let caption = null;       // the text
let speech = null;        // { lines, fontSize, width, height, born, visible }
let speechFade = null;    // a shrinking ghost when it goes away
let speechTarget = null;  // the thing he's pointing at, so the bubble sits above it
const PAD = { w: 24, h: 15 }, TAIL = 18;

function wrap(text, maxWidth) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? line + ' ' + word : word;
    if (ctx.measureText(test).width <= maxWidth || !line) line = test;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  // Break any single word that's still too long.
  return lines.flatMap((l) => {
    if (ctx.measureText(l).width <= maxWidth) return [l];
    const parts = []; let cur = '';
    for (const ch of l) { if (ctx.measureText(cur + ch).width > maxWidth && cur) { parts.push(cur); cur = ch; } else cur += ch; }
    if (cur) parts.push(cur);
    return parts;
  });
}

function layoutCaption(text, keepBorn) {
  // Longer replies get a slightly smaller font and a wider bubble, so it never turns into a tower.
  const length = text.length;
  const fontSize = length <= 50 ? 21 : length <= 110 ? 19 : 17;
  ctx.font = `700 ${fontSize}px Fredoka, "Segoe UI", sans-serif`;
  // Aim for a cosy, balanced shape (a couple of lines) rather than one long strip.
  const maxWidth = Math.min(W * 0.5, 580, Math.max(240, Math.sqrt(length) * 50));
  const lines = wrap(text, maxWidth);
  const textWidth = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const lineHeight = fontSize * 1.28;
  const width = Math.max(Math.ceil(textWidth) + PAD.w * 2, 70);
  const height = Math.ceil(lines.length * lineHeight) + PAD.h * 2;
  const appearing = !speech;
  speech = { lines, fontSize, lineHeight, width, height, born: appearing ? clock() : speech.born };
  if (appearing) speechFade = null;
}

function setCaption(text) {
  text = (text || '').trim();
  if (text === (caption || '')) return;
  if (!text) {
    if (speech) speechFade = { ...speech, frame: lastSpeechFrame, gone: clock() };
    caption = null; speech = null;
    return;
  }
  caption = text;
  layoutCaption(text, true);
}

let lastSpeechFrame = null;
function speechFrame(now, size) {
  // Above the thing he's pointing at (or below his cursor when there's no room up there), otherwise above the phone.
  const margin = 14;
  const pointing = engine.opacity > 0.1 && !engine.isHome;
  let target, origin, tailUp = false;
  const belowCursor = { x: engine.tip.x + engine.size * 0.5, y: engine.tip.y + engine.size * 1.35 };
  if (pointing) {
    const thing = speechTarget || { x: engine.tip.x - 12, y: engine.tip.y - 30, w: 24, h: 24 };
    target = { x: thing.x + thing.w / 2, y: thing.y - 10 };
    origin = { x: target.x - size.width / 2, y: target.y - TAIL - size.height };
    if (origin.y < margin) {
      target = belowCursor;
      origin = { x: target.x - size.width / 2, y: target.y + TAIL };
      tailUp = true;
    }
  } else {
    target = { x: W * settings.phonePosition, y: H - engine.size * 0.9 };
    origin = { x: target.x - size.width / 2, y: target.y - TAIL - size.height };
  }
  origin.x = Math.min(Math.max(origin.x, margin), W - size.width - margin);
  origin.y = Math.min(Math.max(origin.y, margin), H - size.height - margin);
  const float = Math.sin((now - size.born) * 2.2) * 2;  // a gentle bob
  origin.y += float;
  target.y += float * 0.5;
  return { origin, target, tailUp };
}

function bubblePath(c, w, h, target, origin, tailUp) {
  const r = Math.min(24, h / 2), half = 13;
  const localX = target.x - origin.x;
  const baseX = Math.min(Math.max(localX, r + half + 2), w - r - half - 2);
  const lean = Math.min(Math.max(localX - baseX, -TAIL * 1.4), TAIL * 1.4);
  const tip = { x: baseX + lean, y: tailUp ? -TAIL : h + TAIL };
  c.beginPath();
  c.moveTo(r, 0);
  if (tailUp) {
    c.lineTo(baseX - half, 0);
    c.bezierCurveTo(baseX - half * 0.3, 0, tip.x - 1, -TAIL * 0.5, tip.x, tip.y);
    c.bezierCurveTo(tip.x + 2, -TAIL * 0.45, baseX + half * 0.4, 0, baseX + half, 0);
  }
  c.lineTo(w - r, 0);
  c.arcTo(w, 0, w, r, r);
  c.lineTo(w, h - r);
  c.arcTo(w, h, w - r, h, r);
  if (!tailUp) {
    c.lineTo(baseX + half, h);
    c.bezierCurveTo(baseX + half * 0.3, h, tip.x + 1, h + TAIL * 0.5, tip.x, tip.y);
    c.bezierCurveTo(tip.x - 2, h + TAIL * 0.45, baseX - half * 0.4, h, baseX - half, h);
  }
  c.lineTo(r, h);
  c.arcTo(0, h, 0, h - r, r);
  c.lineTo(0, r);
  c.arcTo(0, 0, r, 0, r);
  c.closePath();
}

function drawSpeechBody(s, frame, scale, alpha) {
  const { origin, target, tailUp } = frame;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(origin.x + s.width / 2, origin.y + s.height / 2);
  ctx.scale(scale, scale);
  ctx.translate(-s.width / 2, -s.height / 2);
  bubblePath(ctx, s.width, s.height, target, origin, tailUp);
  const g = ctx.createLinearGradient(0, 0, 0, s.height);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(1, '#EEF0FF');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = P.berry2;
  ctx.stroke();
  ctx.fillStyle = P.ink;
  ctx.font = `700 ${s.fontSize}px Fredoka, "Segoe UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  s.lines.forEach((line, i) => ctx.fillText(line, s.width / 2, PAD.h + s.lineHeight * (i + 0.5) + 1));
  ctx.restore();
}

function drawSpeech(now) {
  if (speechFade) {
    const t = (now - speechFade.gone) / 0.22;
    if (t >= 1 || !speechFade.frame) speechFade = null;
    else drawSpeechBody(speechFade, speechFade.frame, 1 - 0.15 * t * t, 1 - t * t);
  }
  if (!speech) return;
  const frame = speechFrame(now, speech);
  lastSpeechFrame = frame;
  const age = now - speech.born;
  const pop = spring(age, 0.55, 12, 260, 4);
  drawSpeechBody(speech, frame, pop, Math.min(1, age / 0.12));
}

// ───────────── Frame loop ─────────────

resize();
let lastTime = clock();
let lastReport = 0;
function frame() {
  const now = clock();
  const dt = Math.min(Math.max(now - lastTime, 1 / 480), 1 / 20);
  lastTime = now;
  engine.step(dt, now, mouse, { width: W, height: H });
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const visible = settings.showCursor;
  const speed = Math.hypot(engine.velocity.x, engine.velocity.y);
  drawString(now, dt, visible);
  drawTrail(now, speed, visible);
  drawEffects(now);
  drawCursor(now, dt, visible);
  drawLabel(now);
  drawSpeech(now);
  // Tell the main process where he is and what the phone's face should do.
  if (now - lastReport > 1 / 60 - 0.002) {
    lastReport = now;
    window.bluey.send('overlay:state', {
      face: engine.face({ width: W, height: H }, now),
      tip: engine.tip, timeToArrive: engine.timeToArrive(now), isHome: engine.isHome, opacity: engine.opacity,
      size: engine.size,
    });
  }
  frames++;
}
// Windows throttles requestAnimationFrame for transparent click-through windows, so his motion is driven by
// a steady 60 fps timer instead.
let frames = 0;
setInterval(frame, 1000 / 60);
if (/diag/.test(location.search)) setInterval(() => console.warn('[diag] frames', frames), 1000);

// ───────────── Commands from the main process ─────────────

window.bluey.on('overlay:mouse', (m) => { mouse = m; });
window.bluey.on('overlay:settings', (s) => {
  Object.assign(settings, s);
  engine.settings = settings;
});
window.bluey.on('overlay:mode', (m) => engine.setMode(m));
window.bluey.on('overlay:caption', (text) => setCaption(text));
window.bluey.on('overlay:speechTarget', (rect) => { speechTarget = rect; });
window.bluey.on('overlay:bubble', ({ text, life }) => bubble(text, life));
window.bluey.on('overlay:click', ({ x, y, right }) => clickEffect({ x, y }, right));
window.bluey.on('overlay:typed', (text) => typedEffect(text));
window.bluey.on('overlay:press', (depth) => engine.press(depth, clock()));
window.bluey.on('overlay:dragging', (on) => { engine.dragging = on; });
window.bluey.on('overlay:talkTest', (seconds) => { engine.talkUntil = clock() + (seconds || 3); });
window.bluey.on('overlay:brain', ({ awake, mood }) => { engine.awake = !!awake; engine.brainMood = mood || null; });
window.bluey.on('overlay:model', ({ awake, route }) => {
  const badge = document.getElementById('model-badge');
  badge.hidden = !awake;
  badge.textContent = !route?.model ? '● Ready' : `● ${route.brain === 'local' ? '' : route.brain === 'claude' ? 'Claude · ' : 'Codex · '}${route.model}`;
});
window.bluey.on('overlay:chirp', ({ syllables, volume }) => window.BlueyChirp && window.BlueyChirp.play(syllables, volume));
// ───────────── His voice ─────────────
// Replies are read out with the PC's own voices (free, offline). A British English voice if there is one;
// Hindi text gets a Hindi voice if installed.
let voices = [];
const loadVoices = () => { voices = speechSynthesis.getVoices(); };
loadVoices();
speechSynthesis.onvoiceschanged = loadVoices;
function pickVoice(text, wanted) {
  if (wanted) { const v = voices.find((x) => x.name === wanted); if (v) return v; }
  if (/[\u0900-\u097F]/.test(text)) { const hi = voices.find((x) => /^hi/i.test(x.lang)); if (hi) return hi; }
  const rank = (v) => (/en-GB/i.test(v.lang) ? 3 : 0) + (/male|george|ryan|thomas|david|guy/i.test(v.name) && !/female|susan|hazel|zira/i.test(v.name) ? 2 : 0) + (/online|natural/i.test(v.name) ? 1 : 0) + (/^en/i.test(v.lang) ? 1 : 0);
  return [...voices].sort((a, b) => rank(b) - rank(a))[0] || null;
}
function speakLocally(m) {
  speechSynthesis.cancel();
  if (!m || !m.text) return;
  const u = new SpeechSynthesisUtterance(m.text.replace(/[*_`#]/g, ''));
  const v = pickVoice(m.text, m.voice);
  if (v) { u.voice = v; u.lang = v.lang; }
  u.rate = 1.05;
  u.volume = Math.max(0, Math.min(1, m.volume == null ? 0.8 : m.volume));
  u.onerror = (e) => {
    window.bluey.send('overlay:voiceStatus', { id: m.id, playing: false });
    if (e.error !== 'canceled' && e.error !== 'interrupted') window.bluey.send('overlay:micError', 'His voice could not play: ' + e.error);
  };
  window.__lastSpeech = { text: m.text, voice: v && v.name, at: Date.now() };
  const playback = window.__lastSpeech;
  u.onstart = () => { playback.started = true; window.bluey.send('overlay:voiceStatus', { id: m.id, playing: true }); };
  u.onend = () => { playback.ended = true; window.bluey.send('overlay:voiceStatus', { id: m.id, playing: false }); };
  speechSynthesis.speak(u);
}
window.bluey.on('overlay:speak', speakLocally);
// The natural neural voice arrives as an MP3.
let voiceAudio = null;
window.bluey.on('overlay:playAudio', (m) => {
  if (voiceAudio) { try { voiceAudio.pause(); } catch {} voiceAudio = null; }
  if (!m) return;
  speechSynthesis.cancel();
  const a = new Audio('data:audio/mpeg;base64,' + m.base64);
  a.volume = m.volume == null ? 0.9 : m.volume;
  voiceAudio = a;
  window.__audio = a;
  let failed = false;
  const fallback = () => {
    if (failed || voiceAudio !== a) return;
    failed = true;
    a.pause(); voiceAudio = null;
    speakLocally(m);
  };
  a.onerror = fallback;
  a.onplaying = () => { if (voiceAudio === a) window.bluey.send('overlay:voiceStatus', { id: m.id, playing: true }); };
  a.onended = () => { if (voiceAudio === a) { voiceAudio = null; window.bluey.send('overlay:voiceStatus', { id: m.id, playing: false }); } };
  a.play().catch(fallback);
});
window.bluey.on('overlay:voices', () => window.bluey.send('overlay:voiceList', voices.map((v) => ({ name: v.name, lang: v.lang }))));

window.bluey.send('overlay:ready', {});

// ───────────── This PC's microphone (when the phone isn't the mic) ─────────────
// 16 kHz mono PCM16 in ~100 ms pieces, sent to the main process.

let mic = null;
let micGeneration = 0;
async function startMic(deviceId) {
  stopMic();
  const generation = ++micGeneration;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined, channelCount: 1,
      echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const context = new AudioContext({ sampleRate: 16000 });
    await context.audioWorklet.addModule('mic-worklet.js');
    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, 'bluey-mic');
    node.port.onmessage = (e) => window.bluey.send('overlay:audio', e.data);
    source.connect(node);
    mic = { stream, context, node };
    if (!wantMic || generation !== micGeneration) {  // switched off (or restarted) while the mic was opening
      try { node.disconnect(); stream.getTracks().forEach((t) => t.stop()); context.close(); } catch {}
      if (mic && mic.stream === stream) mic = null;
    }
  } catch (e) {
    window.bluey.send('overlay:micError', String(e && e.message || e));
  }
}
function stopMic() {
  if (!mic) { micGeneration++; return; }
  try { mic.node.disconnect(); mic.stream.getTracks().forEach((t) => t.stop()); mic.context.close(); } catch {}
  mic = null;
}
let wantMic = false;
window.bluey.on('overlay:mic', ({ on, deviceId }) => { wantMic = on; if (on) startMic(deviceId); else stopMic(); });
