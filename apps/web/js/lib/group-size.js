// Personal collection supplies a verified number of human members; absent on legacy rows.
export function personalGroupSize(origin) {
  const n = origin?.personalGroupUserCount;
  if (origin?.kind === 'group' && origin.connector === '飞书' && Number.isSafeInteger(n) && n >= 0) return n;
}
