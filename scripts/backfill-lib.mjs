import { collectYahooQuery, makeCardBackfillQueries, sleep } from './yahoo.mjs';

export async function runHistoricalBackfill({
  now,
  cardsConfig,
  queryConfig,
  historyConfig,
  fetchImpl = fetch,
  log = console.log,
  imageOcr = null
}) {
  const horizonHours = historyConfig.rankingHorizonHours ?? 168;
  const since = new Date(now.getTime() - horizonHours * 3600_000);
  const broadMaxPages = historyConfig.broadBackfillPagesPerQuery ?? 30;
  const cardMaxPages = historyConfig.cardBackfillPagesPerQuery ?? 10;
  const resultsPerPage = historyConfig.resultsPerPage ?? 40;
  const throttleMs = historyConfig.throttleMs ?? 450;
  const retryCount = historyConfig.retryCount ?? 2;
  const discovered = [];
  const errors = [];
  const stats = [];

  const jobs = [
    ...queryConfig.queries.map(query => ({ type: 'broad', query, maxPages: broadMaxPages })),
    ...makeCardBackfillQueries(cardsConfig.cards, cardsConfig.aliases).map(x => ({ type: 'card', query: x.query, canonical: x.canonical, maxPages: cardMaxPages }))
  ];

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    try {
      const result = await collectYahooQuery({
        query: job.query,
        cards: cardsConfig.cards,
        aliases: cardsConfig.aliases,
        since,
        maxPages: job.maxPages,
        resultsPerPage,
        throttleMs,
        retryCount,
        fetchImpl,
        onPage: ({ page, entries, parsedPosts, oldestSeenAt }) => log(`[history ${i + 1}/${jobs.length}] page=${page} entries=${entries} parsed=${parsedPosts} oldest=${oldestSeenAt ?? '-'} :: ${job.query}`),
        imageOcr
      });
      discovered.push(...result.posts);
      stats.push({ type: job.type, canonical: job.canonical ?? null, ...result.stats });
    } catch (err) {
      errors.push({ type: job.type, canonical: job.canonical ?? null, query: job.query, message: String(err?.message ?? err) });
      log(`[history error] ${job.query}: ${String(err?.message ?? err)}`);
    }
    if (throttleMs > 0) await sleep(throttleMs);
  }

  const cappedQueries = stats.filter(x => x.capped).length;
  const successfulQueries = stats.length;
  const completedAt = new Date();
  const oldestSeenAt = stats.map(x => x.oldestSeenAt).filter(Boolean).sort()[0] ?? null;
  const backfill = {
    mode: 'rolling-7d',
    startedAt: now.toISOString(),
    completedAt: completedAt.toISOString(),
    targetSince: since.toISOString(),
    targetHours: horizonHours,
    queriesAttempted: jobs.length,
    queriesSucceeded: successfulQueries,
    queriesFailed: errors.length,
    queriesReachedCutoff: stats.filter(x => x.reachedCutoff).length,
    queriesExhausted: stats.filter(x => x.exhausted).length,
    queriesCapped: cappedQueries,
    oldestSeenAt,
    completeWithinSearchResults: errors.length === 0 && cappedQueries === 0,
    discoveredPosts: new Set(discovered.map(p => p.id)).size
  };
  return { discovered, errors, stats, backfill };
}
