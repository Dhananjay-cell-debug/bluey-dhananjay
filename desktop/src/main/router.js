// Picks how hard Bluey thinks for each question, so "hi" is answered instantly by a small model while a real task
// (using your phone, a multi-step job, research, code) gets the smartest model at high effort.
//
//   quick     greetings, thanks, short chat                → small/fast model, low effort
//   standard  everyday questions about your screen        → your chosen model (Opus), medium effort
//   deep      doing things, research, hard or long asks   → your chosen model, high effort (more if you ask for it)
'use strict';

const QUICK_CHAT = /^(hi|hii+|hey+|hello|yo|hola|namaste|namaskar|sup|thanks?|thank you|thx|ok(ay)?|cool|nice|great|awesome|lol|haha|good (morning|night|evening|afternoon)|gm|gn|bye|goodbye|see you|how are you|how's it going|what'?s up|i love you|love you|you there|are you there|test(ing)?|can you hear me|hello bluey|hi bluey|hey bluey)\b/i;
const ACTION = /\b(open|launch|start|send|message|text|call|dial|book|buy|order|pay|post|reply|forward|delete|install|download|upload|fill|submit|log ?in|sign ?in|switch to|go to|navigate|click|tap|type|scroll|drag|play|pause|search for|set (a |an )?(alarm|timer|reminder)|schedule|add to|create|make|write|draft|edit|fix|build|code|debug|run|translate|summar[iy]s?e|compare|research|look up|find out|analy[sz]e|calculate|plan|organi[sz]e|clean up|automate)\b/i;
const PHONE_OR_PC = /\b(on my phone|my phone|whatsapp|instagram|youtube|telegram|claude app|chatgpt app|gmail|on the pc|on my laptop|on my computer)\b/i;
const HARD_WORDS = /\b(difficult|hard|complex|complicated|tricky|challenging|step by step|in detail|thoroughly|carefully|think (hard|carefully|deeply)|deep dive|figure out|prove|strategy|architecture)\b/i;
const MAX_WORDS = /\b(think (as )?hard as you can|maximum effort|max effort|really think|ultra ?think)\b/i;
const SCREEN_Q = /\b(this|that|these|those|here|screen|on my screen|what'?s (this|that)|what does|what is)\b/i;

function words(text) { return (String(text).match(/\S+/g) || []).length; }

/** 'quick' | 'standard' | 'deep', plus why (for the log and the panel). */
function classify(question, { typed = false } = {}) {
  const q = String(question || '').trim();
  const n = words(q);
  if (MAX_WORDS.test(q)) return { tier: 'deep', max: true, why: 'you asked for maximum thinking' };
  if (PHONE_OR_PC.test(q) && ACTION.test(q)) return { tier: 'deep', why: 'a task on your phone or computer' };
  if (HARD_WORDS.test(q)) return { tier: 'deep', why: 'sounds hard' };
  if (n > 28) return { tier: 'deep', why: 'a long request' };
  if (ACTION.test(q) && n >= 5) return { tier: 'deep', why: 'a task to do' };
  if (n <= 8 && QUICK_CHAT.test(q) && !SCREEN_Q.test(q.replace(/^(hi|hey|hello)\b/i, ''))) return { tier: 'quick', why: 'just chat' };
  if (n <= 3 && !SCREEN_Q.test(q) && !ACTION.test(q)) return { tier: 'quick', why: 'very short' };
  return { tier: 'standard', why: 'an everyday question' };
}

const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];
const atLeast = (a, b) => (EFFORT_ORDER.indexOf(a) >= EFFORT_ORDER.indexOf(b) ? a : b);

/**
 * The model and effort for a tier.
 * @param brain 'claude' | 'codex'
 * @param pick  the user's own choices {model, effort} (blank = automatic)
 * @param codexModels  models this ChatGPT plan offers [{id, isDefault, efforts}]
 */
function plan(tier, brain, pick = {}, codexModels = [], max = false) {
  if (brain === 'claude') {
    const smart = pick.model || 'opus';
    const base = pick.effort || 'medium';
    if (tier === 'quick') return { model: 'sonnet', effort: 'low' };
    if (tier === 'standard') return { model: smart, effort: base };
    return { model: smart, effort: max ? 'max' : atLeast(base, 'high') };
  }
  const list = codexModels || [];
  const def = list.find((m) => m.id === pick.model) || list.find((m) => m.isDefault) || list[0];
  const small = list.find((m) => /luna/i.test(m.id) && !/^gpt-5/.test(m.id)) || list.find((m) => /luna/i.test(m.id));
  const supports = (m, e) => !m || !m.efforts || !m.efforts.length || m.efforts.includes(e);
  const clamp = (m, e) => { let i = EFFORT_ORDER.indexOf(e); while (i > 0 && !supports(m, EFFORT_ORDER[i])) i--; return EFFORT_ORDER[Math.max(i, 0)]; };
  const base = pick.effort || 'medium';
  if (tier === 'quick') { const m = small || def; return { model: m && m.id, effort: clamp(m, 'low') }; }
  if (tier === 'standard') return { model: def && def.id, effort: clamp(def, base) };
  return { model: def && def.id, effort: clamp(def, max ? 'max' : atLeast(base, 'high')) };
}

module.exports = { classify, plan };
