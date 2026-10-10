export function budgetPageUrl(budget) {
  const value = budget?.cfoai?.pageUrl ?? budget?.cfoai?.tableUrl;
  if (typeof value !== 'string' || /example|placeholder|your[-_ ]|[<>]/i.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
