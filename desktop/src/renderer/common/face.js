// His face: the landscape blueberry that lives on the phone. Same design and motion as the phone app
// (springs for every part, blinks, brows, moods), drawn on a canvas so the desktop can show him too.
(function (root) {
  'use strict';
  const P = root.BlueyPalette;

  /** A tiny damped spring, so every part of the face moves with a little life. */
  class Spring {
    constructor(value, stiffness = 200, damping = 0.7) { this.value = value; this.velocity = 0; this.stiffness = stiffness; this.damping = damping; }
    step(target, dt) {
      const c = 2 * Math.sqrt(this.stiffness) * this.damping;
      this.velocity += (this.stiffness * (target - this.value) - c * this.velocity) * dt;
      this.value += this.velocity * dt;
    }
  }
  const rand = (a, b) => a + Math.random() * (b - a);

  /** Smooths what the PC asks for into lifelike motion: darting eyes, brows, blinks, leaning, hops. */
  class FaceAnimator {
    constructor() {
      this.target = { gx: 0, gy: 0, mood: 'listening', talk: 0 };
      this.lastPacket = -100;
      this.gazeX = new Spring(0, 260, 0.82); this.gazeY = new Spring(0, 260, 0.82);
      this.pupil = new Spring(1, 160, 0.5); this.browLift = new Spring(0, 180, 0.55); this.browTilt = new Spring(0, 150, 0.6);
      this.lean = new Spring(0, 60, 0.8); this.hop = new Spring(0, 260, 0.35); this.blush = new Spring(0.25, 40, 1); this.squint = new Spring(0, 150, 0.7);
      this.talk = 0; this.mood = 'listening'; this.blinkStart = -1; this.doubleBlink = false; this.nextBlink = 2;
      this.lastTime = null; this.nextSaccade = 0; this.wander = { x: 0, y: -0.3 }; this.jitter = { x: 0, y: 0 }; this.nextJitter = 0; this.nextHop = 6;
      this.localMood = null; this.localTalk = () => 0; this.awake = false; this.touchGaze = null;
    }

    receive(face, time) { this.target = face; this.lastPacket = time; }

    step(now) {
      const dt = Math.min(now - (this.lastTime == null ? now : this.lastTime), 1 / 20);
      this.lastTime = now;
      const live = now - this.lastPacket < 2.5;
      const wanted = this.localMood || (live ? this.target.mood : 'listening');
      if (wanted !== this.mood) {
        this.mood = wanted;
        this.blinkStart = now;  // blink through every mood change
        if (wanted !== 'sleepy' && wanted !== 'resting') { this.hop.velocity += 260; this.pupil.velocity += 3; }
      }
      // Where to look, plus tiny darting movements so the eyes never sit dead still.
      let want;
      if (this.touchGaze) want = this.touchGaze;
      else if (live) want = { x: this.target.gx, y: this.target.gy };
      else {
        if (now > this.nextSaccade) { this.wander = { x: rand(-0.9, 0.9), y: rand(-0.9, 0.4) }; this.nextSaccade = now + rand(0.6, 2.2); }
        want = this.wander;
      }
      if (this.mood === 'thinking') want = { x: 0.6 + 0.08 * Math.sin(now * 1.3), y: -0.85 };
      if (now > this.nextJitter) {
        const a = !this.awake ? 0.015 : this.mood === 'talking' ? 0.07 : this.mood === 'thinking' ? 0.05 : 0.02;
        this.jitter = { x: rand(-a, a), y: rand(-a, a) };
        this.nextJitter = now + rand(0.5, 1.4);
      }
      this.gazeX.step(want.x + this.jitter.x, dt);
      this.gazeY.step(want.y + this.jitter.y, dt);

      let wantTalk = live ? this.target.talk : (this.localMood === 'talking' ? 0.5 + 0.5 * Math.sin(now * 19) * Math.sin(now * 7.3) : 0);
      wantTalk = Math.max(wantTalk, this.localTalk());
      this.talk += (wantTalk - this.talk) * Math.min(1, dt * 25);

      let pupil = 1, lift = 0, tilt = 0, blush = 0.25, squint = 0;
      switch (this.mood) {
        case 'listening': pupil = 1.12; lift = 10; break;
        case 'talking': pupil = 1.05; lift = 6 + this.talk * 18; tilt = 0.05 * Math.sin(now * 2.3); break;
        case 'pointing': pupil = 0.95; lift = -4; tilt = -0.14; break;
        case 'thinking': pupil = 0.9; lift = 4; tilt = 0.22; break;
        case 'happy': pupil = 1.2; lift = 16; blush = 0.85; squint = 1; break;
        case 'resting': pupil = 0.9; lift = -8; blush = 0.15; break;
        case 'sleepy': pupil = 0.88; lift = -10; tilt = 0.12; blush = 0.15; break;
        default: break;
      }
      this.pupil.step(pupil, dt); this.browLift.step(lift, dt); this.browTilt.step(tilt, dt);
      this.blush.step(blush, dt); this.squint.step(squint, dt); this.lean.step(-this.gazeX.value * 0.045, dt);

      // An occasional happy little hop when nothing much is going on.
      if (now > this.nextHop) {
        if (this.talk < 0.05 && this.mood !== 'sleepy' && this.mood !== 'resting') this.hop.velocity += rand(180, 320);
        this.nextHop = now + rand(7, 14);
      }
      this.hop.step(0, dt);

      // Blinks, sometimes doubled. When he's drowsy they're slow and heavy.
      const drowsy = this.mood === 'sleepy';
      if (now > this.nextBlink) {
        this.blinkStart = now;
        this.doubleBlink = !drowsy && Math.random() < 0.25;
        this.nextBlink = now + (drowsy ? rand(1.6, 3) : rand(2, 5));
      }
      const p = (now - this.blinkStart) / (drowsy ? 0.7 : 0.15);
      let closed = p >= 0 && p <= 1 ? Math.sin(Math.PI * p) : 0;
      if (this.doubleBlink && p >= 1.3 && p <= 2.3) closed = Math.sin(Math.PI * (p - 1.3));
      const breathe = Math.sin(now * (this.mood === 'resting' ? 1.1 : 1.8));
      return { gaze: { x: this.gazeX.value, y: this.gazeY.value }, mood: this.mood, talk: this.talk, closed, breathe, time: now,
        pupil: this.pupil.value, browLift: this.browLift.value, browTilt: this.browTilt.value, lean: this.lean.value, hop: this.hop.value,
        blush: this.blush.value, squint: Math.max(0, Math.min(1, this.squint.value)) };
    }
  }

  /** The blob outline: CSS `border-radius: 52% 48% 46% 54% / 58% 56% 44% 42%`. */
  function blobPath(c, x, y, w, h) {
    const tl = [0.52 * w, 0.58 * h], tr = [0.48 * w, 0.56 * h], br = [0.46 * w, 0.44 * h], bl = [0.54 * w, 0.42 * h];
    const k = 0.5523;
    const maxX = x + w, maxY = y + h;
    c.beginPath();
    c.moveTo(x + tl[0], y);
    c.lineTo(maxX - tr[0], y);
    c.bezierCurveTo(maxX - tr[0] * (1 - k), y, maxX, y + tr[1] * (1 - k), maxX, y + tr[1]);
    c.lineTo(maxX, maxY - br[1]);
    c.bezierCurveTo(maxX, maxY - br[1] * (1 - k), maxX - br[0] * (1 - k), maxY, maxX - br[0], maxY);
    c.lineTo(x + bl[0], maxY);
    c.bezierCurveTo(x + bl[0] * (1 - k), maxY, x, maxY - bl[1] * (1 - k), x, maxY - bl[1]);
    c.lineTo(x, y + tl[1]);
    c.bezierCurveTo(x, y + tl[1] * (1 - k), x + tl[0] * (1 - k), y, x + tl[0], y);
    c.closePath();
  }

  function blobGradient(c, x, y, w, h) {
    const g = c.createLinearGradient(x + 0.25 * w, y + 0.067 * h, x + 0.75 * w, y + 0.933 * h);
    P.gradient.forEach((hex, i) => g.addColorStop(P.gradientStops[i], hex));
    return g;
  }

  function crownPath(c, x, y, w, h) {
    const pts = [[30, 4], [36, 16], [52, 12], [40, 24], [46, 36], [30, 28], [14, 36], [20, 24], [8, 12], [24, 16]];
    c.beginPath();
    pts.forEach(([px, py], i) => { const X = x + px / 60 * w, Y = y + py / 40 * h; if (i) c.lineTo(X, Y); else c.moveTo(X, Y); });
    c.closePath();
  }

  const DESIGN = { width: 844, height: 390 };

  /** Fills a shape with his skin (gradient plus the soft shine), for eyelids. */
  function fillSkin(c, body) {
    c.fillStyle = blobGradient(c, body.x, body.y, body.w, body.h);
    c.fill();
    const shine = c.createRadialGradient(body.x + 246, body.y + 126, 0, body.x + 246, body.y + 126, 243);
    shine.addColorStop(0, 'rgba(255,255,255,0.5)');
    shine.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = shine;
    c.fill();
  }

  /** The landscape face on pure black: he fills the canvas and peeks up from the bottom edge. */
  function draw(c, f, width, height, { background = '#000' } = {}) {
    c.save();
    if (background) { c.fillStyle = background; c.fillRect(0, 0, width, height); } else c.clearRect(0, 0, width, height);
    const scale = Math.max(width / DESIGN.width, height / DESIGN.height);
    c.translate((width - DESIGN.width * scale) / 2, height - DESIGN.height * scale);
    c.scale(scale, scale);

    // Whole-body motion: breathing, talking bounce, idle hops, and leaning toward what he looks at.
    const bounce = -f.talk * 16 + f.breathe * 3 - f.hop;
    const body = { x: 12, y: 44 + bounce, w: 820, h: 700 };
    const pivot = { x: body.x + body.w / 2, y: body.y + body.h };
    c.translate(pivot.x, pivot.y);
    c.rotate(f.lean);
    const stretch = 1 + Math.min(0.03, Math.max(-0.03, f.hop / 900));
    c.scale(2 - stretch, stretch);
    c.translate(-pivot.x, -pivot.y);

    // Glow, body, shine and a glossy sparkle.
    c.save();
    c.shadowColor = P.rgba(P.berry2, 0.5);
    c.shadowBlur = 90 * scale;
    c.shadowOffsetY = -10 * scale;
    blobPath(c, body.x, body.y, body.w, body.h);
    c.fillStyle = P.berry3;
    c.fill();
    c.restore();
    blobPath(c, body.x, body.y, body.w, body.h);
    c.fillStyle = blobGradient(c, body.x, body.y, body.w, body.h);
    c.fill();
    c.save();
    blobPath(c, body.x, body.y, body.w, body.h);
    c.clip();
    const shine = c.createRadialGradient(body.x + 246, body.y + 126, 0, body.x + 246, body.y + 126, 243);
    shine.addColorStop(0, 'rgba(255,255,255,0.5)');
    shine.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = shine;
    c.fillRect(body.x, body.y, body.w, body.h);
    c.fillStyle = 'rgba(255,255,255,0.35)';
    c.beginPath(); c.ellipse(body.x + 213, body.y + 51, 23, 11, 0, 0, Math.PI * 2); c.fill();
    c.restore();

    crownPath(c, body.x + 368, body.y - 20 - f.browLift * 0.3, 84, 56);
    c.fillStyle = P.nose;
    c.fill();

    const eyeY = body.y + 157;
    const eyes = [{ x: body.x + 280, y: eyeY }, { x: body.x + 540, y: eyeY }];
    const squash = 1 - f.talk * 0.12;

    // Blushy cheeks, rosier when he's happy.
    c.save();
    c.filter = `blur(${10 * scale}px)`;
    eyes.forEach((e, i) => {
      const side = i === 0 ? -1 : 1;
      c.fillStyle = `rgba(243,166,216,${0.25 + 0.45 * f.blush})`;
      c.beginPath(); c.ellipse(e.x + side * 62, e.y + 117, 45, 21, 0, 0, Math.PI * 2); c.fill();
    });
    c.restore();

    eyes.forEach((e, i) => {
      const side = i === 0 ? -1 : 1;
      // Little arched eyebrows do a lot of the acting.
      c.save();
      const browY = e.y - 112 - Math.min(18, Math.max(-10, f.browLift)) * 0.7;
      c.translate(e.x + side * 6, browY);
      c.rotate(f.browTilt * side * -1 + (f.mood === 'thinking' && i === 1 ? -0.25 : 0));
      c.beginPath(); c.moveTo(-38, 6); c.quadraticCurveTo(0, -12, 38, 6);
      c.strokeStyle = P.nose; c.lineWidth = 14; c.lineCap = 'round'; c.stroke();
      c.restore();

      if (f.mood === 'resting') {
        c.beginPath(); c.moveTo(e.x - 62, e.y + 6); c.quadraticCurveTo(e.x, e.y + 52, e.x + 62, e.y + 6);
        c.strokeStyle = P.ink; c.lineWidth = 18; c.lineCap = 'round'; c.stroke();
        return;
      }
      if (f.mood === 'happy' && f.squint > 0.6) {
        c.beginPath(); c.moveTo(e.x - 60, e.y + 34); c.quadraticCurveTo(e.x, e.y - 54, e.x + 60, e.y + 34);
        c.strokeStyle = P.ink; c.lineWidth = 24; c.lineCap = 'round'; c.stroke();
        return;
      }
      const open = Math.max(0.06, 1 - f.closed) * squash;
      const white = { x: e.x - 95, y: e.y - 95 * open, w: 190, h: 190 * open };
      c.beginPath(); c.ellipse(e.x, e.y, 95, 95 * open, 0, 0, Math.PI * 2);
      c.fillStyle = '#fff'; c.fill();
      if (open <= 0.2) return;
      c.save();
      c.beginPath(); c.ellipse(e.x, e.y, 95, 95 * open, 0, 0, Math.PI * 2); c.clip();
      let g = { ...f.gaze };
      const len = Math.hypot(g.x, g.y);
      if (len > 1) g = { x: g.x / len, y: g.y / len };
      const reach = 50, r = 46 * f.pupil;
      const pupil = { x: e.x + g.x * reach - side * 3, y: e.y + g.y * reach * open };
      if (f.mood === 'sleepy') pupil.y = Math.max(pupil.y, e.y) + 28;  // eyes sink under heavy lids
      c.fillStyle = P.ink;
      c.beginPath(); c.arc(pupil.x, pupil.y, r, 0, Math.PI * 2); c.fill();
      // Two catchlights make them shine.
      c.fillStyle = '#fff';
      c.beginPath(); c.arc(pupil.x - r * 0.58 + r * 0.28, pupil.y - r * 0.72 + r * 0.28, r * 0.28, 0, Math.PI * 2); c.fill();
      c.fillStyle = 'rgba(255,255,255,0.85)';
      c.beginPath(); c.arc(pupil.x + r * 0.28 + r * 0.12, pupil.y + r * 0.22 + r * 0.12, r * 0.12, 0, Math.PI * 2); c.fill();
      // Happy cheeks push up from below as he smiles.
      if (f.squint > 0.02) {
        c.beginPath(); c.ellipse(e.x, e.y + 95 * open - 70 * f.squint + 80, 110, 80, 0, 0, Math.PI * 2);
        fillSkin(c, body);
      }
      // Heavy, droopy lids when he's getting sleepy.
      if (f.mood === 'sleepy') {
        const droop = 0.5 + 0.06 * Math.sin(f.time * 1.3);
        c.beginPath(); c.rect(e.x - 100, white.y - 10, 200, white.h * droop + 10);
        fillSkin(c, body);
        c.beginPath(); c.moveTo(e.x - 92, white.y + white.h * droop); c.lineTo(e.x + 92, white.y + white.h * droop);
        c.strokeStyle = P.rgba(P.nose, 0.7); c.lineWidth = 8; c.lineCap = 'round'; c.stroke();
      }
      // A soft upper lid when he's focused on pointing.
      if (f.mood === 'pointing') {
        c.beginPath(); c.rect(e.x - 100, white.y - 20, 200, 40);
        fillSkin(c, body);
      }
      c.restore();
    });

    c.font = '700 26px Fredoka, "Segoe UI", sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    if (f.mood === 'resting') {
      // Little z's floating up while he naps.
      for (let i = 0; i < 3; i++) {
        const phase = (f.time * 0.35 + i / 3) % 1;
        const size = 26 + i * 8;
        c.font = `700 ${size}px Fredoka, "Segoe UI", sans-serif`;
        c.fillStyle = `rgba(255,255,255,${0.9 * Math.sin(Math.PI * phase)})`;
        c.fillText('z', body.x + 660 + phase * 70 + Math.sin(phase * 6) * 8, body.y + 90 - phase * 110);
      }
    }
    if (f.mood === 'thinking') {
      for (let i = 0; i < 3; i++) {
        const wobble = Math.sin(f.time * 3 + i) * 4;
        c.fillStyle = `rgba(255,255,255,${1 - i * 0.3})`;
        c.beginPath(); c.arc(body.x + 698 + i * 26, body.y + 48 - i * 12 + wobble, 8, 0, Math.PI * 2); c.fill();
      }
    }

    // His little mouth-nose: opens as he talks, curls into a smile when he's happy.
    const noseW = 60 - f.talk * 8, noseH = 38 + f.talk * 34;
    const nose = { x: body.x + 410 - noseW / 2, y: body.y + 272 - f.talk * 6, w: noseW, h: noseH };
    c.fillStyle = P.nose;
    if (f.mood === 'happy' && f.talk < 0.1) {
      c.beginPath(); c.moveTo(nose.x - 8, nose.y + 8); c.quadraticCurveTo(nose.x + nose.w / 2, nose.y + 58, nose.x + nose.w + 8, nose.y + 8); c.closePath(); c.fill();
    } else {
      c.beginPath(); c.ellipse(nose.x + nose.w / 2, nose.y + nose.h / 2, nose.w / 2, nose.h / 2, 0, 0, Math.PI * 2); c.fill();
      if (f.talk > 0.25) {
        c.fillStyle = 'rgba(229,139,196,0.9)';
        c.beginPath(); c.ellipse(nose.x + nose.w / 2, nose.y + nose.h - noseH * 0.38 + noseH * 0.15, noseW * 0.28, noseH * 0.15, 0, 0, Math.PI * 2); c.fill();
      }
    }
    c.restore();
  }

  /** A tiny Bluey: the blob with two googly eyes. */
  function mini(c, x, y, w, h, look = { x: 0.15, y: 0.25 }) {
    blobPath(c, x, y, w, h);
    c.fillStyle = blobGradient(c, x, y, w, h);
    c.fill();
    const r = w * 0.13, cy = y + h / 2 - w * 0.04;
    for (const cx of [x + w / 2 - w * 0.18, x + w / 2 + w * 0.18]) {
      c.fillStyle = '#fff'; c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.fill();
      c.fillStyle = P.ink; c.beginPath(); c.arc(cx + look.x * r * 0.45, cy + look.y * r * 0.45, w * 0.06, 0, Math.PI * 2); c.fill();
    }
  }

  root.BlueyFace = { FaceAnimator, draw, mini, blobPath, blobGradient, DESIGN };
})(window);
