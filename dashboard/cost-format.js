const dollars = (nanos, digits) => `$${((nanos ?? 0) / 1e9).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

export function attemptAmounts(cost, ceiling, stopped = false) {
  let digits = cost !== 0 && Math.abs(cost) < 10_000_000 ? 4 : 2;
  if (ceiling != null) {
    if (stopped || (cost !== ceiling && (Math.abs(cost - ceiling) < 10_000_000 || dollars(cost, digits) === dollars(ceiling, digits)))) digits = Math.max(digits, 4);
    // Preserve the ordering even when the difference is smaller than a cent.
    while (cost !== ceiling && dollars(cost, digits) === dollars(ceiling, digits) && digits < 9) digits++;
  }
  return { cost: dollars(cost, digits), ceiling: ceiling == null ? null : dollars(ceiling, digits) };
}

export function attemptReason(row) {
  const reason = row.resultReason ?? '';
  if (row.result !== 'stopped' || row.ceilingNanos == null) return reason;
  const amounts = attemptAmounts(row.estimatedCostNanos, row.ceilingNanos, true);
  return reason.replace(/^ceiling crossed: \$[\d,.]+ spent against (?:a )?\$[\d,.]+ ceiling/i,
    `ceiling crossed: ${amounts.cost} spent against a ${amounts.ceiling} ceiling`);
}
