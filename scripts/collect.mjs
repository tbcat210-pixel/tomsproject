import { readJson, writeJson } from './lib.mjs';
import { collectYahooQuery, sleep } from './yahoo.mjs';
import { loadConfig, mergePosts, paths, saveSnapshot } from './collector-core.mjs';
import { runHistoricalBackfill } from './backfill-lib.mjs';
import { createTradeImageOcr } from './image-ocr.mjs';

const { cardsConfig, queryConfig, historyConfig } = await loadConfig();
const now = new Date();
const state = await readJson(paths.state, {});
const oldPosts = await readJson(paths.posts, []);
const discovered = [];
const errors = [];
const imageOcr = await createTradeImageOcr({
  cards: cardsConfig.cards,
  aliases: cardsConfig.aliases,
  cachePath: paths.ocrCache,
  enabled: historyConfig.imageOcrEnabled ?? true,
  maxImagesPerPost: historyConfig.imageOcrMaxImagesPerPost ?? 4,
  maxNewImagesPerRun: historyConfig.imageOcrMaxNewImagesPerRun ?? 200,
  maxCandidatePasses: historyConfig.imageOcrMaxCandidatePasses ?? 10,
  upscaleMinWidth: historyConfig.imageOcrUpscaleMinWidth ?? 1500,
  upscaleMaxWidth: historyConfig.imageOcrUpscaleMaxWidth ?? 2600,
  timeoutMs: historyConfig.imageOcrTimeoutMs ?? 30_000,
  cacheHours: historyConfig.imageOcrCacheHours ?? 720,
  cacheVersion: historyConfig.imageOcrCacheVersion ?? 3
});

const recentSince = new Date(now.getTime() - 72 * 3600_000);
for (const query of queryConfig.queries) {
  try {
    const result = await collectYahooQuery({
      query,
      cards: cardsConfig.cards,
      aliases: cardsConfig.aliases,
      since: recentSince,
      maxPages: historyConfig.recentPagesPerQuery ?? 3,
      resultsPerPage: historyConfig.resultsPerPage ?? 40,
      throttleMs: historyConfig.throttleMs ?? 450,
      retryCount: historyConfig.retryCount ?? 2,
      onPage: ({ page, entries, parsedPosts }) => console.log(`[recent] page=${page} entries=${entries} parsed=${parsedPosts} :: ${query}`),
      imageOcr
    });
    discovered.push(...result.posts);
  } catch (err) {
    errors.push({ mode: 'recent', query, message: String(err?.message ?? err) });
    console.error(`[recent error] ${query}: ${String(err?.message ?? err)}`);
  }
  await sleep(historyConfig.throttleMs ?? 450);
}

const dueHours = historyConfig.autoBackfillEveryHours ?? 24;
const lastBackfillMs = state.lastBackfill?.completedAt ? new Date(state.lastBackfill.completedAt).getTime() : 0;
const backfillDue = !lastBackfillMs || now.getTime() - lastBackfillMs >= dueHours * 3600_000;

let lastBackfill = state.lastBackfill ?? null;
if (backfillDue) {
  console.log('Historical 7-day backfill is due. Starting rolling backfill...');
  const history = await runHistoricalBackfill({ now, cardsConfig, queryConfig, historyConfig, imageOcr });
  discovered.push(...history.discovered);
  errors.push(...history.errors.map(e => ({ mode: 'history', ...e })));
  lastBackfill = history.backfill;
} else {
  console.log(`Historical backfill skipped; last completed at ${state.lastBackfill.completedAt}`);
}

const posts = mergePosts(oldPosts, discovered, now, historyConfig.storageHorizonHours ?? 192);
const ocrStats = imageOcr.getStats();
await imageOcr.finalize();
const nextState = { ...state, lastBackfill, imageOcr: { ...ocrStats, lastRunAt: now.toISOString() } };
await saveSnapshot({ now, posts, cardsConfig, queryConfig, state: nextState, discoveredThisRun: discovered.length, errors, backfill: lastBackfill });
await writeJson(paths.state, { ...nextState, firstSuccessfulCollectionAt: nextState.firstSuccessfulCollectionAt || (posts.length ? now.toISOString() : null), lastRunAt: now.toISOString(), lastRunDiscovered: discovered.length, lastRunErrors: errors });
console.log(`stored=${posts.length} ocrNew=${ocrStats.newImages} ocrPosts=${ocrStats.postsFromImages}`);
