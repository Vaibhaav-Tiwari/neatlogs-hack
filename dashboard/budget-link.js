export function budgetPageUrl(budget) {
  const value = budget?.cfoai?.tableUrl ?? budget?.cfoai?.pageUrl;
  if (typeof value !== 'string' || /example|placeholder|your[-_ ]|[<>]/i.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
export function budgetProvenance(budget) {
  const limitSource = budget.limitSource ?? budget.source;
  return {
    limit: limitSource === 'cli' ? 'command-line cap' : limitSource === 'cfoai' ? 'cfo.ai budget table' : 'tally.yaml',
    record: (budget.systemOfRecord ?? (budget.source === 'cfoai' ? 'cfoai' : 'ledger')) === 'cfoai' ? 'cfo.ai' : 'ledger',
  };
}
