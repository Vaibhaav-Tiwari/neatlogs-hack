const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function sessionEvidence(sessionId, { project, insideAO = false } = {}) {
  if (!sessionId) return '';
  const href = insideAO && project ? `ao://sessions/${encodeURIComponent(project)}/${encodeURIComponent(sessionId)}` : null;
  return `<span class="session-evidence evidence-id">${href ? `<a href="${esc(href)}">AO session</a>` : 'AO session'} <code tabindex="0" title="${esc(sessionId)}">${esc(sessionId)}</code> <button type="button" class="copy-session" data-copy-session="${esc(sessionId)}" title="Copy AO session id" aria-label="Copy AO session ${esc(sessionId)}">Copy</button><span class="l-note session-copy-note" aria-live="polite">open in Agent Orchestrator</span></span>`;
}

export function copyableIdEvidence(label, value) {
  if (!value) return '';
  return `<span class="evidence-id">${esc(label)} <code tabindex="0" title="${esc(value)}">${esc(value)}</code> <button type="button" class="copy-session" data-copy-id="${esc(value)}" title="Copy ${esc(label)}: ${esc(value)}" aria-label="Copy ${esc(label)}">Copy</button><span class="l-note copy-note" aria-live="polite"></span></span>`;
}

export function installSessionCopy(root = document) {
  root.addEventListener('click', async event => {
    const button = event.target.closest?.('[data-copy-session], [data-copy-id]');
    if (!button) return;
    const evidence = button.closest('.evidence-id');
    const note = evidence.querySelector('.session-copy-note, .copy-note');
    const isSession = button.hasAttribute('data-copy-session');
    try {
      await navigator.clipboard.writeText(button.dataset.copySession ?? button.dataset.copyId);
      note.textContent = isSession ? 'Copied; open in Agent Orchestrator' : 'Copied';
    } catch {
      const code = evidence.querySelector('code');
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      code.focus();
      note.textContent = isSession ? 'Selected; copy and open in Agent Orchestrator' : 'Selected; copy the id';
    }
  });
}
