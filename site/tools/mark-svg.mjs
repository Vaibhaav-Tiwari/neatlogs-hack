// Turns the CLI's own logo frames (cli/logo.ts, truecolour) into one crisp SVG.
// Every block-character half becomes a square; each square carries the number
// of the frame in which the terminal first draws it, so CSS can replay the
// same draw-in with no script. No dependency on dist/, so tests can import it.

const BLOCKS = { '█': [1, 1], '▀': [1, 0], '▄': [0, 1] };

/** One frame as a map of "x,y" to 'ink' or 'slash', plus its text runs. Each cell is one wide and two pixels tall. */
export function readFrame(lines) {
  const pixels = new Map();
  const texts = [];
  lines.forEach((line, row) => {
    let x = 0;
    let slashFg = false, slashBg = false, italic = false;
    let run = null;
    for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
      const style = /^\x1b\[([0-9;]*)m$/.exec(part);
      if (style) {
        const codes = style[1].split(';');
        if (style[1] === '0' || style[1] === '') { slashFg = slashBg = italic = false; }
        for (let i = 0; i < codes.length; i++) {
          if (codes[i] === '3') italic = true;
          else if (codes[i] === '38' && codes[i + 1] === '2') { slashFg = true; i += 4; }
          else if (codes[i] === '48' && codes[i + 1] === '2') { slashBg = true; i += 4; }
        }
        run = null;
        continue;
      }
      for (const char of part) {
        const halves = BLOCKS[char];
        if (halves) {
          // With a slash background, the half the glyph leaves empty is slash and the drawn half is ink.
          halves.forEach((on, half) => {
            if (on) pixels.set(`${x},${row * 2 + half}`, slashFg ? 'slash' : 'ink');
            else if (slashBg) pixels.set(`${x},${row * 2 + half}`, 'slash');
          });
          run = null;
        } else if (char !== ' ' && char !== '▔') {
          if (!run) { run = { x, row, text: '', italic }; texts.push(run); }
          run.text += char;
        } else if (run && char === ' ') {
          run.text += char;
        }
        x += 1;
      }
    }
  });
  for (const run of texts) run.text = run.text.trimEnd();
  return { pixels, texts };
}

/**
 * The settled logo as SVG markup. `crop` keeps only the first columns (the mark without the wordmark).
 * With `animate`, squares carry `--t` (frame number) and eyes are marked so the page can blink them.
 */
export function markSvg(frames, { crop = null, animate = true, title = 'Meet Tally, the CFO for your agent fleet', className = 'pixel-mark' } = {}) {
  const read = frames.map(readFrame);
  const last = read.at(-1);
  const inCrop = (x) => crop === null || x < crop;
  const firstStable = (key) => {
    let index = read.length - 1;
    while (index > 0 && read[index - 1].pixels.get(key) === last.pixels.get(key)) index -= 1;
    return index;
  };
  const firstSeen = (key) => read.findIndex((frame) => frame.pixels.has(key));
  const width = crop ?? Math.max(...[...last.pixels.keys()].map((key) => Number(key.split(',')[0]) + 1), ...last.texts.map((run) => run.x + run.text.length));
  const height = Math.max(...[...last.pixels.keys()].map((key) => Number(key.split(',')[1]) + 1));

  // A square shows from the first frame the terminal draws it in its final colour. Where the slash later
  // crosses a stroke, the stroke's square is kept underneath from its own first frame, so strokes draw whole.
  const cells = [];
  for (const [key, color] of last.pixels.entries()) {
    const [x, y] = key.split(',').map(Number);
    if (!inCrop(x)) continue;
    const seen = firstSeen(key);
    const inColor = read.findIndex((frame) => frame.pixels.get(key) === color);
    if (inColor > seen) cells.push({ x, y, color: read[seen].pixels.get(key), t: seen, eye: false, under: true });
    cells.push({ x, y, color, t: inColor, eye: color === 'ink' && inColor < firstStable(key), under: false });
  }
  cells.sort((p, q) => Number(q.under) - Number(p.under) || p.y - q.y || p.x - q.x);
  const rects = [];
  for (const cell of cells) {
    const previous = rects.at(-1);
    if (previous && previous.y === cell.y && previous.x + previous.w === cell.x && previous.color === cell.color && previous.t === cell.t && previous.eye === cell.eye && previous.under === cell.under) previous.w += 1;
    else rects.push({ ...cell, w: 1 });
  }
  const shut = read.findIndex((frame, index) => index > 0 && cells.some((cell) => cell.eye && read[index - 1].pixels.has(`${cell.x},${cell.y}`) && !frame.pixels.has(`${cell.x},${cell.y}`)));
  const body = rects.map((r) => {
    const classes = [r.color === 'slash' ? 'sl' : 'ink', r.eye ? 'eye' : ''].filter(Boolean).join(' ');
    return `<rect class="${classes}" x="${r.x}" y="${r.y}" width="${r.w}" height="1"${animate ? ` style="--t:${r.t}"` : ''}/>`;
  });
  if (crop === null) {
    for (const run of last.texts) {
      const t = read.findIndex((frame) => frame.texts.some((other) => other.row === run.row && other.text === run.text));
      const escaped = run.text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      body.push(`<text class="${run.italic ? 'it' : 'tx'}" x="${run.x}" y="${run.row * 2 + 1.52}" textLength="${run.text.length}" lengthAdjust="spacingAndGlyphs"${animate ? ` style="--t:${t}"` : ''}>${escaped}</text>`);
    }
  }
  const blink = animate && shut > 0 ? ` style="--shut:${shut}"` : '';
  return `<svg class="${className}${animate ? ' draws' : ''}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}" shape-rendering="crispEdges"${blink}>${body.join('')}</svg>`;
}
