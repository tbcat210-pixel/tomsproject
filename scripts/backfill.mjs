import { readJson, writeJson } from './lib.mjs';
import { loadConfig, mergePosts, paths, saveSnapshot } from './collector-core.mjs';
import { runHistoricalBackfill } from './backfill-lib.mjs';
import { createTradeImageOcr } from './image-ocr.mjs';

const { cardsConfig, queryConfig, historyConfig } = await loadConfig();
const now = new Date();
const state = await readJson(paths.state, {});
const oldPosts = await readJson(paths.posts, []);
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
  upscaleMinWidth: historyConfig.imageOcrUpscaleMinWidth ?? 2400,
  upscaleMaxWidth: historyConfig.imageOcrUpscaleMaxWidth ?? 4200,
  timeoutMs: historyConfig.imageOcrTimeoutMs ?? 30_000,
  cacheHours: historyConfig.imageOcrCacheHours ?? 720,
  cacheVersion: historyConfig.imageOcrCacheVersion ?? 9
});

const history = await runHistoricalBackfill({ now, cardsConfig, queryConfig, historyConfig, imageOcr });
const posts = mergePosts(oldPosts, history.discovered, now, historyConfig.storageHorizonHours ?? 192);
const ocrStats = imageOcr.getStats();
await imageOcr.finalize();
const nextState = { ...state, lastBackfill: history.backfill, imageOcr: { ...ocrStats, lastRunAt: now.toISOString() } };
await saveSnapshot({ now, posts, cardsConfig, queryConfig, state: nextState, discoveredThisRun: new Set(history.discovered.map(p => p.id)).size, errors: history.errors, backfill: history.backfill });
await writeJson(paths.state, { ...nextState, firstSuccessfulCollectionAt: nextState.firstSuccessfulCollectionAt || (posts.length ? now.toISOString() : null), lastRunAt: now.toISOString(), lastRunDiscovered: new Set(history.discovered.map(p => p.id)).size, lastRunErrors: history.errors });
console.log(`backfill stored=${posts.length}, found=${history.backfill.discoveredPosts}, complete=${history.backfill.completeWithinSearchResults}, ocrNew=${ocrStats.newImages}, ocrPosts=${ocrStats.postsFromImages}, gameWithCells=${ocrStats.gameWithCells ?? 0}, gameWithMatched=${ocrStats.gameWithMatchedCells ?? 0}`);
