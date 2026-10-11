// Tally project page. The page reads fine without this file; it adds the copy
// button, the replayed terminal, the three switches, scroll reveals and replays.

const still = window.matchMedia('(prefers-reduced-motion: reduce)');
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

// ---------- phone menu ----------

const head = document.querySelector('.site-head');
const menuButton = document.querySelector('.menu-button');
if (head && menuButton) {
  menuButton.hidden = false;
  const setOpen = (open) => { head.classList.toggle('open', open); menuButton.setAttribute('aria-expanded', String(open)); menuButton.textContent = open ? 'Close' : 'Menu'; };
  menuButton.addEventListener('click', () => setOpen(!head.classList.contains('open')));
  head.querySelector('nav').addEventListener('click', (event) => { if (event.target.closest('a')) setOpen(false); });
  addEventListener('keydown', (event) => { if (event.key === 'Escape') setOpen(false); });
}

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

// ---------- three switches redraw one real run ----------
// Values marked real come from run-20261011-130259Z, which ran with Entire off, neatlogs on, cfo.ai on.
// The other position of each switch describes what Tally records differently and invents no ids or amounts.

const sample = document.querySelector('[data-sample]');
if (sample) {
  const real = { entire: false, neatlogs: true, cfoai: true };
  const state = { ...real };
  const absent = (text) => `<span class="absent">${text}</span>`;
  const fields = (now) => ({
    sized: now.entire ? 'the code graph, read through Entire' : 'the issue text and a search of the repository',
    checkpoint: now.entire ? 'one attached to each commit' : absent('none'),
    dtrace: now.neatlogs ? '0d5826efa109e27125df7ce43b766572' : absent('no trace'),
    wtrace: now.neatlogs ? '028d92600350d1be5cc76b4cc35d10be' : absent('no trace'),
    budget: now.cfoai ? '$40.00 a month' : '$5.00',
    budgetsrc: now.cfoai ? 'read live from cfo.ai' : 'typed into tally.yaml',
    spend: now.cfoai ? '$0.0109 for this run, written back to cfo.ai and reconciled to the ledger' : '$0.0109 for this run, kept in the local ledger only',
    state: Object.keys(real).every((key) => now[key] === real[key])
      ? 'Shown exactly as this run was recorded.'
      : 'Changed from the real run: this is what Tally would record with these settings.',
  });
  const paint = (flash) => {
    const next = fields(state);
    for (const [name, html] of Object.entries(next)) {
      const node = sample.querySelector(`[data-f="${name}"]`);
      if (!node || node.innerHTML === html) continue;
      node.innerHTML = html;
      if (flash && !still.matches) { node.classList.remove('redrawn'); void node.offsetWidth; node.classList.add('redrawn'); }
    }
    sample.querySelector('[data-f="state"]').classList.toggle('changed', next.state.startsWith('Changed'));
    // $0.0109 of the budget in force: 0.03% of $40.00, 0.22% of $5.00. Drawn at a visible minimum width.
    sample.querySelector('[data-f="meter"]').style.width = state.cfoai ? '0.03%' : '0.22%';
  };
  for (const button of document.querySelectorAll('[data-switch]')) {
    const key = button.dataset.switch;
    const row = button.closest('.sw');
    button.hidden = false;
    row.dataset.on = String(state[key]);
    button.addEventListener('click', () => {
      state[key] = !state[key];
      button.setAttribute('aria-checked', String(state[key]));
      row.dataset.on = String(state[key]);
      paint(true);
    });
  }
  paint(false);
}

// ---------- proof: costs count up once, when first seen ----------

const counters = [...document.querySelectorAll('[data-count]')];
if (counters.length && 'IntersectionObserver' in window && !still.matches) {
  const tick = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      tick.unobserve(entry.target);
      const target = Number(entry.target.dataset.count);
      const began = performance.now();
      const step = (now) => {
        const share = Math.min(1, (now - began) / 1100);
        entry.target.textContent = `$${(target * (1 - (1 - share) ** 3)).toFixed(4)}`;
        if (share < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
  }, { threshold: 0.6 });
  counters.forEach((node) => tick.observe(node));
}

// ---------- onboarding video: one attribute swaps the placeholder for the real thing ----------

const tv = document.querySelector('.video-frame[data-video]');
if (tv && tv.dataset.video.trim()) {
  const source = tv.dataset.video.trim();
  const tube = tv.querySelector('.screen');
  let player = null;
  if (/\.(mp4|webm|mov)(\?.*)?$/i.test(source)) {
    player = document.createElement('video');
    player.controls = true;
    player.preload = 'metadata';
    player.playsInline = true;
    player.src = source;
  } else if (/^https:\/\//i.test(source)) {
    player = document.createElement('iframe');
    player.src = source;
    player.title = 'Tally onboarding video';
    player.loading = 'lazy';
    player.allow = 'fullscreen; picture-in-picture';
    player.allowFullscreen = true;
  }
  if (player) { tube.append(player); tv.classList.add('has-video'); }
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

// ---------- the mark: play the CLI's draw-in again ----------

const markStage = document.querySelector('[data-mark]');
const replayMark = document.querySelector('[data-replay-mark]');
if (markStage && replayMark && !still.matches) {
  replayMark.hidden = false;
  replayMark.addEventListener('click', () => {
    // CSS animations restart only when their element re-enters the page.
    const mark = markStage.querySelector('svg');
    mark.replaceWith(mark.cloneNode(true));
  });
}
