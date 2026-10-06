'use strict';
// His face, docked at the bottom of the screen when no phone is connected. Double click: wake / sleep.
// Press and hold: ask. Drag: his eyes follow your finger (like the phone).
const canvas = document.getElementById('face'), ctx = canvas.getContext('2d');
const animator = new BlueyFace.FaceAnimator();
const MOODS = { asleep: null, waking: 'happy', listening: null, asking: 'listening', thinking: 'thinking', speaking: 'talking' };
let talkUntil = 0;
function draw() {
  const dpr = devicePixelRatio || 1, w = innerWidth, h = innerHeight;
  if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const now = performance.now() / 1000;
  animator.localTalk = () => (now < talkUntil ? 0.5 + 0.5 * Math.sin(now * 19) * Math.sin(now * 7.3) : 0);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  BlueyFace.draw(ctx, animator.step(now), w, h, { background: null });
}
setInterval(draw, 1000 / 60);
window.bluey.on('dock:face', (f) => animator.receive(f, performance.now() / 1000));
window.bluey.on('dock:state', (s) => { document.body.className = s; animator.awake = s !== 'asleep'; animator.localMood = MOODS[s]; });
window.bluey.on('dock:talk', (seconds) => { talkUntil = performance.now() / 1000 + seconds; });
let holdTimer = null, asking = false, lastUp = 0;
const gaze = (e) => ({ x: Math.max(-1, Math.min(1, (e.clientX / innerWidth) * 2 - 1)), y: Math.max(-1, Math.min(1, (e.clientY / innerHeight) * 2 - 1)) });
canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); window.bluey.send('dock:menu'); });
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  canvas.setPointerCapture(e.pointerId);
  animator.touchGaze = gaze(e);
  holdTimer = setTimeout(() => { asking = true; window.bluey.send('dock:askStart'); }, 300);
});
canvas.addEventListener('pointermove', (e) => { if (animator.touchGaze) animator.touchGaze = gaze(e); });
canvas.addEventListener('pointerup', () => {
  clearTimeout(holdTimer);
  animator.touchGaze = null;
  if (asking) { asking = false; window.bluey.send('dock:askEnd'); return; }
  const now = Date.now();
  if (now - lastUp < 350) { window.bluey.send('dock:toggle'); lastUp = 0; } else lastUp = now;
});
