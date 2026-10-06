// The research card: shows while he researches, then previews the report. Click to expand; minus to close.
'use strict';
const card = document.getElementById('card');
const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const glass = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="#6C86F5" stroke-width="3" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21"/></svg>';

function render(m) {
  m = m || {};
  const report = m.report, expanded = !!m.expanded && !!report;
  card.className = 'card ' + (expanded ? 'expanded' : report ? 'collapsed' : '');
  let html = `<div class="head">${glass}<h1>${esc(report ? report.title : m.error ? 'Research' : 'Researching')}</h1>`;
  if (expanded) html += '<button id="up" title="Back to preview">⌃</button>';
  html += '<button id="close" title="Close">−</button></div>';
  if (report) {
    if (expanded) {
      html += '<div class="body">' + report.paragraphs.map((p) => `<p>${esc(p)}</p>`).join('');
      if (report.sources && report.sources.length) {
        html += '<div class="label">SOURCES</div>' + report.sources.map((s) => `<a class="source" data-url="${esc(s.url)}" title="${esc(s.url)}">${esc(s.title)}</a>`).join('');
      }
      html += '</div>';
    } else {
      html += `<p class="preview">${esc(report.paragraphs.join(' '))}</p><div class="more">Click to read more</div>`;
    }
  } else if (m.error) {
    html += `<div class="error">${esc(m.error)}</div>`;
  } else {
    html += `<div class="loading"><div class="spinner"></div><div>Doing some research on “${esc(m.question)}”</div></div>`;
  }
  card.innerHTML = html;
  const close = document.getElementById('close');
  if (close) close.onclick = (e) => { e.stopPropagation(); window.bluey.send('report:close'); };
  const up = document.getElementById('up');
  if (up) up.onclick = (e) => { e.stopPropagation(); window.bluey.send('report:toggle'); };
  card.onclick = () => { if (report && !expanded) window.bluey.send('report:toggle'); };
  card.querySelectorAll('.source').forEach((a) => { a.onclick = (e) => { e.stopPropagation(); window.bluey.invoke('panel:openExternal', a.dataset.url); }; });
  requestAnimationFrame(() => window.bluey.send('report:size', card.getBoundingClientRect().height + 8));
}
window.bluey.on('report:model', render);
