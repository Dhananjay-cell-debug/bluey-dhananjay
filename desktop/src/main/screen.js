// A look at the screen, in the overlay's coordinates (DIPs, top-left origin): every line and word of text
// (from Windows OCR) and the front app's controls (from UI Automation), each with a short id the brain
// can point at or click, plus positions on a 0-1000 grid so it can relate them to the screenshot.
'use strict';

class Snapshot {
  /**
   * @param raw  the helper's snapshot reply (physical pixels)
   * @param display  {width, height} of the primary display in DIPs
   */
  constructor(raw, display) {
    this.scale = raw.width / display.width || 1;
    this.left = raw.left || 0;
    this.top = raw.top || 0;
    this.size = { width: display.width, height: display.height };
    this.jpeg = raw.jpeg;
    this.app = raw.app || null;
    this.title = raw.title || null;
    const rect = (b) => ({ x: (b.x - this.left) / this.scale, y: (b.y - this.top) / this.scale, w: b.w / this.scale, h: b.h / this.scale });
    let wordCount = 0;
    this.lines = (raw.lines || []).slice(0, 400).map((l, i) => {
      const words = (l.words || []).length > 1 && wordCount < 600
        ? l.words.map((w) => ({ id: 'W' + (++wordCount), text: w.text, rect: rect(w) })) : [];
      return { id: 'L' + (i + 1), text: l.text, rect: rect(l), words };
    });
    this.controls = (raw.controls || []).map((c, i) => ({ id: 'C' + (i + 1), kind: c.kind, label: c.label || '', rect: rect(c) }));
  }

  /** DIP point -> physical screen pixel, for real clicks. */
  toPhysical(p) { return { x: Math.round(p.x * this.scale + this.left), y: Math.round(p.y * this.scale + this.top) }; }

  target(id) {
    id = String(id || '').trim().toUpperCase();
    const c = this.controls.find((x) => x.id === id);
    if (c) return { id: c.id, text: c.label || c.kind, rect: c.rect };
    for (const line of this.lines) {
      if (line.id === id) return line;
      const w = line.words.find((x) => x.id === id);
      if (w) return w;
    }
    return null;
  }

  candidates() {
    const out = this.controls.map((c) => ({ id: c.id, text: c.label || c.kind, rect: c.rect }));
    for (const l of this.lines) { out.push(l); out.push(...l.words); }
    return out;
  }

  /** What's under (or right next to) a point: the smallest word, line or control there. */
  targetNear(p) {
    const all = this.candidates();
    const inside = all.filter((t) => p.x >= t.rect.x - 6 && p.x <= t.rect.x + t.rect.w + 6 && p.y >= t.rect.y - 6 && p.y <= t.rect.y + t.rect.h + 6);
    if (inside.length) return inside.sort((a, b) => a.rect.w * a.rect.h - b.rect.w * b.rect.h)[0];
    const distance = (r) => Math.hypot(Math.max(r.x - p.x, 0, p.x - (r.x + r.w)), Math.max(r.y - p.y, 0, p.y - (r.y + r.h)));
    const near = all.filter((t) => distance(t.rect) < 60).sort((a, b) => distance(a.rect) - distance(b.rect));
    return near[0] || null;
  }

  grid(r) {
    return `@${Math.round((r.x + r.w / 2) / this.size.width * 1000)},${Math.round((r.y + r.h / 2) / this.size.height * 1000)}`;
  }

  /** The list the brain picks from. */
  get targetList() {
    const out = [];
    if (this.app) out.push(`Frontmost app: ${this.app}${this.title ? ` — "${this.title.slice(0, 80)}"` : ''}`);
    if (this.controls.length) {
      out.push('Controls (click these by id):');
      for (const c of this.controls) out.push(`${c.id} ${c.kind} ${this.grid(c.rect)}${c.label ? ` "${c.label}"` : ''}`);
    }
    out.push('Text on screen (L = line, W = word, @x,y on a 0-1000 grid):');
    if (!this.lines.length) out.push('(no text found)');
    for (const l of this.lines) {
      const words = l.words.length > 1 ? ' | ' + l.words.map((w) => `${w.id}=${w.text}`).join(' ') : '';
      out.push(`${l.id} ${this.grid(l.rect)} "${l.text}"${words}`);
    }
    return out.join('\n');
  }

  /** A 0-1000 grid position -> DIP point. */
  gridPoint(x, y) {
    const c = (v) => Math.min(Math.max(Number(v) || 0, 0), 1000) / 1000;
    return { x: c(x) * this.size.width, y: c(y) * this.size.height };
  }
}

module.exports = { Snapshot };
