// Rolling 24-hour page budget based on the former four daily runs (~18 pages each).
// New 4-hour schedule: six runs/day, at most 12 Yahoo requests each.
export const MAX_YAHOO_REQUESTS_PER_RUN = 12;
export const MAX_YAHOO_REQUESTS_PER_24_HOURS = 72;
const DAY_MS = 24 * 3600_000;

export function requestsWithin24Hours(requestTimes = [], now = new Date()) {
  const end = now.getTime();
  return (Array.isArray(requestTimes) ? requestTimes : []).filter(value => {
    const at = new Date(value).getTime();
    return Number.isFinite(at) && at > end - DAY_MS && at <= end;
  });
}

export function pagesForQuery({ remainingRun, remainingDay, queriesLeft, maxPagesPerQuery }) {
  const left = Math.max(0, Math.floor(Number(queriesLeft) || 0));
  const quota = Math.max(0, Math.floor(Math.min(Number(remainingRun) || 0, Number(remainingDay) || 0)));
  const maximum = Math.max(0, Math.floor(Number(maxPagesPerQuery) || 0));
  if (!left || !quota || !maximum) return 0;

  // Cover all eight search terms before spending the spare four pages on depth.
  const reserve = left - 1;
  return Math.min(maximum, Math.max(1, quota - reserve));
}
