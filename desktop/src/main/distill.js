'use strict';
const { oneShot } = require('./brain/oneshot');

const SYSTEM = `You maintain a short "how this person works" guide for their personal assistant, Bluey. You are shown what the user asked in one session (their own words, spoken or typed) and Bluey's replies. \
Extract ONLY durable things worth remembering for next time: how they like answers (length, language, tone), corrections they gave about how Bluey worked, how they write prompts for AI tools (their structure, level of detail, habits), \
apps/sites/contacts they routinely use for a purpose, and repeatable multi-step routines they asked for. Skip one-off task content, facts about the world, anything said by other people, anything sensitive (passwords, codes, payment or ID details, health) and guesses. \
Each item is one plain sentence about the user, written so another assistant can act on it, plus a short evidence quote from the user's words. Reply with ONLY JSON: {"items":[{"kind":"preference"|"workflow"|"prompt_style","text":"...","evidence":"..."}]}. Use {"items":[]} when nothing qualifies. At most 3 items.`;

/** The user's own words from a finished session, with Bluey's replies as context. Nothing said by anyone else is used. */
function transcript(entries) {
  const lines = [];
  let asked = 0;
  for (const e of entries || []) {
    if (e.kind === 'asked') { asked++; lines.push('User: ' + e.text); }
    else if (e.kind === 'reply') lines.push('Bluey: ' + String(e.text).slice(0, 240));
  }
  return { asked, text: lines.join('\n').slice(-6000) };
}

function parse(text) {
  const t = String(text || '');
  const start = t.indexOf('{'), end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  try { const items = JSON.parse(t.slice(start, end + 1)).items; return Array.isArray(items) ? items : []; } catch { return []; }
}

/** Looks at one finished session and saves what's durable. Returns the saved items. */
async function distill({ entries, learning, brain, workDir, run = oneShot }) {
  if (!learning || !learning.enabled) return [];
  const { asked, text } = transcript(entries);
  if (asked < 2 || text.length < 60) return [];
  const answer = await run(text, { system: SYSTEM, brain, workDir });
  const saved = [];
  for (const item of parse(answer).slice(0, 3)) {
    try {
      saved.push(learning.put({ kind: item.kind, text: item.text, evidence: item.evidence, source: 'Noticed in a session', auto: true }));
    } catch {}
  }
  return saved;
}

module.exports = { distill, transcript, parse, SYSTEM };
