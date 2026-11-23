function invalid(message: string): never {
  throw Object.assign(new Error(message), { status: 400 });
}

export function validateLocalDay(day: unknown, label: string): asserts day is string {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) invalid(label + '须为 YYYY-MM-DD');
  const midnight = new Date(day + 'T00:00:00Z');
  if (!Number.isFinite(+midnight) || midnight.toISOString().slice(0, 10) !== day) invalid(label + '不存在');
}

/** Validate the calendar date once and format each instant in the selected zone, including DST transitions. */
export function localDayFormatter(day: unknown, timeZone: unknown, label: string) {
  if (day === undefined && timeZone === undefined) return undefined;
  validateLocalDay(day, label);
  if (typeof timeZone !== 'string' || !timeZone.trim()) invalid('按当地日期查询须提供时区');
  try {
    return new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch { return invalid(label + '查询时区无效'); }
}
