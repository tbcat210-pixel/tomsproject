import { readJson, writeJson } from './lib.mjs';
import { collectYahooQuery, sleep } from './yahoo.mjs';
import { loadConfig, mergePosts, paths, saveSnapshot } from './collector-core.mjs';
import { runHistoricalBackfill } from './backfill-lib.mjs';
import { createTradeImageOcr } from './image-ocr.mjs';
import {
  MAX_YAHOO_REQUESTS_PER_RUN,
  MAX_YAHOO_REQUESTS_PER_24_HOURS,
  requestsWithin24Hours,
  pagesForQuery
} from './request-budget.mjs';

const { cardsConfig, queryConfig, historyConfig } = await loadConfig();
const supporterNameMap = await readJson(new URL('../config/supporter-name-map.json', import.meta.url), {});
const cardImageReferenceCache = paths.ocrCache.replace(/ocr-cache\.json$/, 'card-image-reference.json');
const now = new Date();
const state = await readJson(paths.state, {});
const oldPosts = await readJson(paths.posts, []);
// Reuse only already-accepted, fully parsed posts. New/unrecognized posts
// still run through the exact same image OCR and text classifiers.
const knownPostsById = new Map();
for (const post of oldPosts) {
  if (post?.id && Array.isArray(post.demand) && Array.isArray(post.supply) && !knownPostsById.has(String(post.id))) {
    knownPostsById.set(String(post.id), post);
  }
}
// Count actual attempted Yahoo pages, not only successful responses.
const recentRequestTimes = requestsWithin24Hours(state.yahooRequestTimes, now);
const thisRunRequestTimes = [];
const queryStats = [];
const discovered = [];
const errors = [];
const imageOcr = await createTradeImageOcr({
  cards: cardsConfig.cards,
  aliases: cardsConfig.aliases,
  cachePath: paths.ocrCache,
  enabled: historyConfig.imageOcrEnabled ?? true,
  maxImagesPerPost: historyConfig.imageOcrMaxImagesPerPost ?? 4,
  maxNewImagesPerRun: historyConfig.imageOcrMaxNewImagesPerRun ?? 200,
  maxCandidatePasses: historyConfig.imageOcrMaxCandidatePasses ?? 12,
  gameWithPassesPerCard: historyConfig.imageOcrGameWithPassesPerCard ?? 7,
  gameWithBadgePasses: historyConfig.imageOcrGameWithBadgePasses ?? 5,
  requireVerifiedStar2: historyConfig.imageOcrRequireVerifiedStar2 ?? true,
  processingBudgetMs: historyConfig.imageOcrProcessingBudgetMs ?? 10_800_000,
  imageMatchEnabled: historyConfig.imageMatchEnabled ?? true,
  imageMatchReferenceCachePath: cardImageReferenceCache,
  imageMatchNameMap: supporterNameMap,
  imageMatchRefreshHours: historyConfig.imageMatchRefreshHours ?? 24,
  imageMatchStrongScore: historyConfig.imageMatchStrongScore ?? 0.92,
  imageMatchAgreeScore: historyConfig.imageMatchAgreeScore ?? 0.80,
  imageMatchMinMargin: historyConfig.imageMatchMinMargin ?? 0.035,
  imageMatchStrongMargin: historyConfig.imageMatchStrongMargin ?? 0.055,
  upscaleMinWidth: historyConfig.imageOcrUpscaleMinWidth ?? 2400,
  upscaleMaxWidth: historyConfig.imageOcrUpscaleMaxWidth ?? 4200,
  timeoutMs: historyConfig.imageOcrTimeoutMs ?? 30_000,
  cacheHours: historyConfig.imageOcrCacheHours ?? 720,
  cacheVersion: historyConfig.imageOcrCacheVersion ?? 10
});

const recentSince = new Date(now.getTime() - 24 * 3600_000);
const pageThrottleMs = historyConfig.throttleMs ?? 90_000;
const queryThrottleMs = historyConfig.queryThrottleMs ?? 180_000;

for (let i = 0; i < queryConfig.queries.length; i++) {
  const query = queryConfig.queries[i];
  const maxPages = pagesForQuery({
    remainingRun: MAX_YAHOO_REQUESTS_PER_RUN - thisRunRequestTimes.length,
    remainingDay: MAX_YAHOO_REQUESTS_PER_24_HOURS - recentRequestTimes.length - thisRunRequestTimes.length,
    queriesLeft: queryConfig.queries.length - i,
    maxPagesPerQuery: historyConfig.recentPagesPerQuery ?? 3
  });
  if (maxPages === 0) {
    console.warn(`[budget] Skipping Yahoo query until request quota replenishes: ${query}`);
    queryStats.push({ query, pages: 0, skipped: 'Yahoo 24-hour request cap' });
    continue;
  }
  try {
    const result = await collectYahooQuery({
      query,
      cards: cardsConfig.cards,
      aliases: cardsConfig.aliases,
      since: recentSince,
      maxPages,
      resultsPerPage: historyConfig.resultsPerPage ?? 40,
      throttleMs: pageThrottleMs,
      retryCount: historyConfig.retryCount ?? 0,
      cachedPostsById: knownPostsById,
      onRequest: () => thisRunRequestTimes.push(new Date().toISOString()),
      onPage: ({ page, entries, parsedPosts }) =>
        console.log(`[recent] page=${page} entries=${entries} parsed=${parsedPosts} :: ${query}`),
      imageOcr
    });
    discovered.push(...result.posts);
    queryStats.push(result.stats);
  } catch (err) {
    const message = String(err?.message ?? err);
    errors.push({ mode: 'recent', query, message });
    queryStats.push({ query, pages: 0, error: message });
    console.error(`[recent error] ${query}: ${message}`);
    if (message.includes('ACCESS_BLOCKED')) break;
  }

  if (i < queryConfig.queries.length - 1 && queryThrottleMs > 0) {
    console.log(`[gentle] waiting ${Math.round(queryThrottleMs / 1000)}s before next Yahoo search`);
    await sleep(queryThrottleMs);
  }
}

const dueHours = historyConfig.autoBackfillEveryHours ?? 24;
const lastBackfillMs = state.lastBackfill?.completedAt ? new Date(state.lastBackfill.completedAt).getTime() : 0;
const backfillDue = false;

let lastBackfill = state.lastBackfill ?? null;
if (backfillDue) {
  console.log('Historical 7-day backfill is due. Starting rolling backfill...');
  const history = await runHistoricalBackfill({ now, cardsConfig, queryConfig, historyConfig, imageOcr });
  discovered.push(...history.discovered);
  errors.push(...history.errors.map(e => ({ mode: 'history', ...e })));
  lastBackfill = history.backfill;
} else {
  console.log('Historical bulk backfill disabled; recent catch-up collection only.');
}

const posts = mergePosts(oldPosts, discovered, now, historyConfig.storageHorizonHours ?? 192);
const ocrStats = imageOcr.getStats();
await imageOcr.finalize();
const nextState = {
  ...state,
  lastBackfill,
  imageOcr: { ...ocrStats, lastRunAt: now.toISOString() },
  yahooRequestTimes: [...recentRequestTimes, ...thisRunRequestTimes],
  yahooCollection: {
    requestsThisRun: thisRunRequestTimes.length,
    requestsIn24HourWindow: recentRequestTimes.length + thisRunRequestTimes.length,
    maxPerRun: MAX_YAHOO_REQUESTS_PER_RUN,
    maxPer24Hours: MAX_YAHOO_REQUESTS_PER_24_HOURS,
    queries: queryStats
  }
};
console.log(`[budget] Yahoo requests this run=${thisRunRequestTimes.length}, 24h=${nextState.yahooCollection.requestsIn24HourWindow}/${MAX_YAHOO_REQUESTS_PER_24_HOURS}`);
await saveSnapshot({
  now,
  posts,
  cardsConfig,
  queryConfig,
  state: nextState,
  discoveredThisRun: discovered.length,
  errors,
  backfill: lastBackfill
});
await writeJson(paths.state, {
  ...nextState,
  firstSuccessfulCollectionAt:
    nextState.firstSuccessfulCollectionAt || (posts.length ? now.toISOString() : null),
  lastRunAt: now.toISOString(),
  lastRunDiscovered: discovered.length,
  lastRunErrors: errors
});
console.log(`stored=${posts.length} ocrNew=${ocrStats.newImages} ocrPosts=${ocrStats.postsFromImages} gameWithCells=${ocrStats.gameWithCells ?? 0} gameWithMatched=${ocrStats.gameWithMatchedCells ?? 0}`);
