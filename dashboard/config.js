// Where the page reads from. Each value can also be set in the address bar,
// e.g. index.html?data=../.tally/runs/latest/&baseline=runs/baseline/&interval=1000
window.TALLY_DASHBOARD = {
  // Folder holding run.json and ledger.json, relative to this page.
  data: '../.tally/runs/latest/',
  // Folder holding a baseline run to compare against, or null for none.
  baseline: null,
  // Milliseconds between reads.
  intervalMs: 2000,
  // AO project id used to make session ids clickable inside AO Desktop.
  aoProject: 'neatlogs-hack',
  // Shown only when `?demo` is present, or when `?replay` has no explicit data.
  sample: '../schema/fixtures/finished-run/',
};
