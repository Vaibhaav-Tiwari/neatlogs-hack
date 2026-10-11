// Tally project page. The page reads fine without this file; it adds the
// copy button, the replayed terminal, scroll reveals and the hero replay.

const still = window.matchMedia('(prefers-reduced-motion: reduce)');
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

// ---------- scroll reveals ----------

const reveals = document.querySelectorAll('.reveal');
if ('IntersectionObserver' in window && !still.matches) {
  const seen = new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.isIntersecting) { entry.target.classList.add('in'); seen.unobserve(entry.target); }
  }, { rootMargin: '0px 0px -12% 0px' });
  reveals.forEach((node) => seen.observe(node));
} else {
  reveals.forEach((node) => node.classList.add('in'));
}

// ---------- copy the install command ----------

for (const button of document.querySelectorAll('[data-copy]')) {
  const label = button.querySelector('[data-copy-label]');
  const status = document.querySelector('.copy-status');
  button.hidden = false;
  button.addEventListener('click', async () => {
    const text = button.dataset.copy;
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      // Older browsers and insecure pages: select the command so Ctrl+C works.
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('install-command'));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      try { copied = document.execCommand('copy'); } catch { copied = false; }
    }
    button.classList.toggle('done', copied);
    label.textContent = copied ? 'Copied' : 'Copy';
    status.textContent = copied ? `Copied: ${text}` : 'Could not copy automatically. The command is selected; press Ctrl+C or Cmd+C.';
    setTimeout(() => { button.classList.remove('done'); label.textContent = 'Copy'; }, 2400);
  });
}

// ---------- the terminal: the CLI's own logo frames, then lines from a real run ----------

const logo = document.querySelector('[data-term-logo]');
const lines = document.querySelector('[data-term-lines]');
const replayTerm = document.querySelector('[data-replay-term]');
let termRun = 0;

async function playTerminal() {
  const data = window.TALLY_LOGO;
  if (!logo || !lines || !data) return;
  const run = ++termRun;
  const rows = [...lines.querySelectorAll('p')];
  lines.classList.add('playing');
  rows.forEach((row) => row.classList.remove('shown', 'caret'));
  for (const frame of data.frames) {
    if (run !== termRun) return;
    logo.innerHTML = frame;
    await wait(data.frameMs);
  }
  await wait(500);
  for (const row of rows) {
    if (run !== termRun) return;
    rows.forEach((other) => other.classList.remove('caret'));
    row.classList.add('shown', 'caret');
    // Commands are "typed"; output arrives at the pace of a run, spend lines a little slower.
    await wait(row.classList.contains('cmd') ? 900 : row.classList.contains('spend') ? 520 : 240);
  }
  rows.forEach((row) => row.classList.remove('caret'));
  lines.classList.remove('playing');
}

if (logo && window.TALLY_LOGO && !still.matches) {
  if (replayTerm) { replayTerm.hidden = false; replayTerm.addEventListener('click', playTerminal); }
  if ('IntersectionObserver' in window) {
    const onScreen = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { onScreen.disconnect(); playTerminal(); }
    }, { threshold: 0.35 });
    onScreen.observe(logo.closest('.terminal'));
  } else {
    playTerminal();
  }
}

// ---------- hero: play the draw-in again ----------

const hero = document.querySelector('.hero');
function armHeroReplay() {
  const button = hero.querySelector('[data-replay-hero]');
  button.hidden = false;
  button.addEventListener('click', () => {
    // CSS animations restart only when their elements re-enter the page.
    const stage = hero.querySelector('.hero-stage');
    stage.replaceWith(stage.cloneNode(true));
    armHeroReplay();
    hero.querySelector('[data-replay-hero]').focus();
  });
}
if (hero && hero.querySelector('[data-replay-hero]') && !still.matches) armHeroReplay();
