// Where the big character cursor is and how it moves. Pure math (no drawing), shared by the overlay
// and the tests. Coordinates are DIPs, top-left origin, y down.
(function (root) {
  'use strict';

  /** A CSS-style cubic-bezier timing curve: maps time (0…1) to progress (0…1). */
  class TimingCurve {
    constructor(x1, y1, x2, y2) { Object.assign(this, { x1, y1, x2, y2 }); }
    coordinate(t, a, b) { const u = 1 - t; return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t; }
    derivative(t, a, b) { const u = 1 - t; return 3 * u * u * a + 6 * u * t * (b - a) + 3 * t * t * (1 - b); }
    parameter(x) {
      let t = x;
      for (let i = 0; i < 8; i++) {
        const error = this.coordinate(t, this.x1, this.x2) - x;
        if (Math.abs(error) < 1e-7) return t;
        const d = this.derivative(t, this.x1, this.x2);
        if (Math.abs(d) < 1e-7) break;
        t -= error / d;
      }
      let low = 0, high = 1;
      t = x;
      for (let i = 0; i < 40; i++) {
        const value = this.coordinate(t, this.x1, this.x2);
        if (Math.abs(value - x) < 1e-7) break;
        if (value < x) low = t; else high = t;
        t = (low + high) / 2;
      }
      return t;
    }
    value(x) { if (x <= 0) return 0; if (x >= 1) return 1; return this.coordinate(this.parameter(x), this.y1, this.y2); }
    rate(x) {
      const t = this.parameter(Math.min(Math.max(x, 0), 1));
      const dx = this.derivative(t, this.x1, this.x2), dy = this.derivative(t, this.y1, this.y2);
      return dx > 1e-7 ? dy / dx : 0;
    }
  }
  /** Starts gently, then arrives with a long, soft deceleration. */
  TimingCurve.launch = new TimingCurve(0.42, 0, 0.22, 1);
  /** Keeps the speed it already had (a change of plans mid-flight), then settles the same way. */
  TimingCurve.redirect = new TimingCurve(0.25, 0.25, 0.22, 1);
  /** Even and deliberate, for drags. */
  TimingCurve.steady = new TimingCurve(0.42, 0, 0.38, 1);

  /** One planned trip: a smooth cubic curve walked with an easing curve. */
  class Flight {
    constructor(o) { Object.assign(this, o); this.landed = false; }
    progress(now) { return this.duration <= 0 ? 1 : Math.min(1, Math.max(0, (now - this.start) / this.duration)); }
    position(e) {
      const u = 1 - e, a = u * u * u, b = 3 * u * u * e, c = 3 * u * e * e, d = e * e * e;
      return { x: a * this.from.x + b * this.c1.x + c * this.c2.x + d * this.to.x,
               y: a * this.from.y + b * this.c1.y + c * this.c2.y + d * this.to.y };
    }
    tangent(e) {
      const u = 1 - e, a = 3 * u * u, b = 6 * u * e, c = 3 * e * e;
      return { x: a * (this.c1.x - this.from.x) + b * (this.c2.x - this.c1.x) + c * (this.to.x - this.c2.x),
               y: a * (this.c1.y - this.from.y) + b * (this.c2.y - this.c1.y) + c * (this.to.y - this.c2.y) };
    }
  }

  const hypot = Math.hypot;
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  class CursorEngine {
    constructor(settings) {
      this.settings = settings || { cursorSize: 72, phonePosition: 0.5, mood: 'listening' };
      this.mode = { kind: 'following' };   // docked | following | pinned {x, y}
      this.tip = { x: -1000, y: -1000 };
      this.velocity = { x: 0, y: 0 };
      this.angle = Math.PI / 4;
      this.angleVelocity = 0;
      this.opacity = 0;
      this.flight = null;
      this.placed = false;
      this.bounds = { width: 1440, height: 900 };
      this.dragging = false;
      this.onLand = null;
      this.onLaunch = null;
      this.landedAt = -10;
      this.pressStart = -10;
      this.pressDepth = 0;
      this.talkUntil = 0;
      this.brainMood = null;
      this.gazeOverride = null;
      this.awake = false;
      this.mouse = { x: 0, y: 0 };
      this.lastMouseMove = 0;
      this.blinkUntil = 0;
      this.nextBlink = 3;
    }

    get size() { return this.settings.cursorSize || 72; }
    setMode(mode) { this.mode = mode; }
    get isHome() { return this.mode.kind !== 'pinned'; }

    /** Where the phone sits, just below the bottom edge of the screen. */
    phonePoint(b) { return { x: b.width * this.settings.phonePosition, y: b.height + b.height * 0.18 }; }
    /** Peeking up from the bottom edge, right above the phone. */
    dockPoint(b) { return { x: b.width * this.settings.phonePosition, y: b.height - this.size * 0.42 }; }
    /** Just below the bottom edge, out of sight, as if tucked into the phone. */
    tuckedPoint(b) { return { x: b.width * this.settings.phonePosition, y: b.height + this.size * 0.35 }; }

    goal() {
      switch (this.mode.kind) {
        case 'docked': return this.dockPoint(this.bounds);
        case 'pinned': return { x: this.mode.x, y: this.mode.y };
        default: return this.tuckedPoint(this.bounds);
      }
    }

    /** Seconds until the current trip arrives. */
    timeToArrive(now) {
      if (!this.flight) return 0;
      return Math.max(0, this.flight.start + this.flight.duration - now);
    }

    /** A little squish toward the tip, like pressing a button. */
    press(depth, now) { this.pressStart = now; this.pressDepth = depth; }

    step(dt, now, mouse, bounds) {
      this.bounds = bounds;
      if (hypot(mouse.x - this.mouse.x, mouse.y - this.mouse.y) > 1.5) this.lastMouseMove = now;
      this.mouse = mouse;
      if (!this.placed) {
        this.tip = this.tuckedPoint(bounds);
        this.placed = true;
        this.lastMouseMove = now;
        this.nextBlink = now + 3;
      }
      const target = this.goal();
      const needsPlan = this.flight
        ? hypot(this.flight.to.x - target.x, this.flight.to.y - target.y) > 0.5
        : hypot(this.tip.x - target.x, this.tip.y - target.y) > 0.5;
      if (needsPlan) this.plan(target, now);
      this.advance(now);

      // Fades in the moment it leaves home; in follow mode it fades out once it has tucked itself away.
      const settled = (this.flight ? this.flight.progress(now) : 1) >= 1;
      const want = (this.mode.kind === 'following' && settled) ? 0 : 1;
      const rate = want > this.opacity ? 12 : 6;
      this.opacity += (want - this.opacity) * Math.min(1, dt * rate);

      // Upright like a normal cursor while out and about (tipped up when parked), leaning a touch into the motion.
      const lean = clamp(this.velocity.x / 2800, -0.2, 0.2);
      const targetAngle = (this.isHome ? Math.PI / 4 : 0) + lean;
      const k = 24;
      this.angleVelocity += (k * (targetAngle - this.angle) - 2 * Math.sqrt(k) * this.angleVelocity) * dt;
      this.angle += this.angleVelocity * dt;

      if (now > this.nextBlink) {
        this.blinkUntil = now + 0.13;
        this.nextBlink = now + 2.5 + Math.random() * 3.5;
      }
    }

    /** Plans a natural-looking trip: a gentle curve, timed like a real hand movement, with a soft landing. */
    plan(goal, now) {
      const from = { ...this.tip };
      const dx = goal.x - from.x, dy = goal.y - from.y;
      const distance = hypot(dx, dy);
      const pointing = !this.isHome;
      const dock = this.dockPoint(this.bounds);
      const fromHome = hypot(from.x - dock.x, from.y - dock.y) < this.size * 1.2 || from.y > this.bounds.height - 2;
      if (distance <= 0.5) {
        this.flight = new Flight({ from, c1: from, c2: goal, to: goal, start: now, duration: 0, timing: TimingCurve.launch, pointing });
        return;
      }
      let duration = Math.min(1.2, Math.max(0.45, 0.4 + 0.12 * Math.log2(1 + distance / 24)));
      if (this.mode.fast && !this.dragging) duration = Math.min(0.3, Math.max(0.12, 0.08 + distance / 6000));
      if (this.dragging) duration = Math.min(1.6, Math.max(0.6, duration * 1.45));

      const dir = { x: dx / distance, y: dy / distance };
      let normal = { x: -dir.y, y: dir.x };
      if (Math.abs(dir.x) > 0.4) {
        if (normal.y > 0) normal = { x: -normal.x, y: -normal.y };  // sideways trips bow gently upward
      } else {
        const towardMiddle = this.bounds.width / 2 - (from.x + goal.x) / 2 >= 0 ? 1 : -1;
        if (normal.x * towardMiddle < 0) normal = { x: -normal.x, y: -normal.y };  // vertical trips bow toward the middle
      }
      const bow = this.dragging ? 0 : Math.min(distance * 0.1, 70) * 0.75;
      const reach = distance * 0.3;
      const c2 = { x: goal.x - dir.x * reach + normal.x * bow, y: goal.y - dir.y * reach + normal.y * bow };

      const speed = hypot(this.velocity.x, this.velocity.y);
      let c1, timing;
      if (speed > 60) {
        // A change of plans mid-flight: carry on from the current speed and heading, no kink.
        let carry = { x: this.velocity.x * duration / 3, y: this.velocity.y * duration / 3 };
        const length = hypot(carry.x, carry.y);
        if (length > distance * 0.6) carry = { x: carry.x / length * distance * 0.6, y: carry.y / length * distance * 0.6 };
        c1 = { x: from.x + carry.x, y: from.y + carry.y };
        timing = TimingCurve.redirect;
      } else {
        c1 = { x: from.x + dir.x * reach + normal.x * bow, y: from.y + dir.y * reach + normal.y * bow };
        timing = this.dragging ? TimingCurve.steady : TimingCurve.launch;
      }
      this.flight = new Flight({ from, c1, c2, to: { ...goal }, start: now, duration, timing, pointing });
      if (pointing && fromHome && this.onLaunch) this.onLaunch({ x: dock.x, y: this.bounds.height });
    }

    advance(now) {
      const flight = this.flight;
      if (!flight) { this.velocity = { x: 0, y: 0 }; return; }
      const p = flight.progress(now);
      const e = flight.timing.value(p);
      this.tip = flight.position(e);
      if (p >= 1) {
        this.velocity = { x: 0, y: 0 };
        if (!flight.landed) {
          flight.landed = true;
          if (flight.pointing) {
            this.landedAt = now;
            if (this.onLand) this.onLand(this.tip);
          } else if (this.mode.kind === 'following' && this.onLaunch) {
            this.onLaunch({ x: this.tip.x, y: this.bounds.height });
          }
        }
      } else {
        const rate = flight.timing.rate(p) / flight.duration;
        const d = flight.tangent(e);
        this.velocity = { x: d.x * rate, y: d.y * rate };
      }
    }

    /** Scale for the press squish: a quick press, then a spring back with the tiniest rebound. */
    pressScale(now) {
      const t = now - this.pressStart;
      if (t < 0 || t >= 0.42) return 1;
      if (t < 0.12) return 1 - this.pressDepth * Math.sin(t / 0.12 * Math.PI / 2);
      const r = (t - 0.12) / 0.3;
      return 1 - this.pressDepth * Math.cos(r * Math.PI * 1.5) * Math.exp(-r * 3.2);
    }

    /** A slow, gentle hover while it holds a point (eased in so it never jumps). */
    hover(now) {
      if (this.isHome || (this.flight ? this.flight.progress(now) : 1) < 1) return 0;
      const since = now - this.landedAt;
      const amount = clamp((since - 0.35) / 0.6, 0, 1);
      return Math.sin(since * 2.4) * 1.6 * amount;
    }

    get bodyCenter() {
      const r = this.size * 0.5 * Math.SQRT2;
      return { x: this.tip.x + Math.cos(this.angle + Math.PI / 4) * r, y: this.tip.y + Math.sin(this.angle + Math.PI / 4) * r };
    }

    /** What the phone's face should do: look at the cursor (or at your mouse in follow mode). */
    face(bounds, now) {
      const phone = this.phonePoint(bounds);
      const c = this.mode.kind === 'following' ? this.mouse : this.bodyCenter;
      let gx = clamp((c.x - phone.x) / (bounds.width * 0.5), -1, 1);
      let gy = -clamp((phone.y - c.y) / (bounds.height * 1.1), 0.15, 1);
      if (this.gazeOverride) { gx = this.gazeOverride.x; gy = this.gazeOverride.y; }
      const testing = now < this.talkUntil;
      const talk = testing ? 0.5 + 0.5 * Math.sin(now * 19) * Math.sin(now * 7.3) : 0;
      let mood = this.settings.mood || 'listening';
      if (this.brainMood) mood = this.brainMood;
      else if (testing) mood = 'talking';
      else if (this.mode.kind === 'pinned' && mood === 'listening') mood = 'pointing';
      else if (this.mode.kind === 'following' && !this.awake && mood === 'listening') {
        // Your mouse sat still: he gets drowsy after 5 seconds and dozes off after 15.
        const idle = now - this.lastMouseMove;
        if (idle > 15) mood = 'resting'; else if (idle > 5) mood = 'sleepy';
      }
      return { gx, gy, mood, talk };
    }
  }

  const api = { TimingCurve, Flight, CursorEngine };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BlueyEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
