import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRankings, readJson, writeJson } from './lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(__dirname, '..');
export const paths = {
  posts: path.join(root, '.collector-data/posts.json'),
  rankings: path.join(root, 'docs/data/rankings.json'),
  state: path.join(root, '.collector-data/state.json'),
  ocrCache: path.join(root, '.collector-data/ocr-cache.json'),
  cards: path.join(root, 'config/cards.json'),
  queries: path.join(root, 'config/queries.json'),
  history: path.join(root, 'config/history.json')
};

export async function loadConfig() {
  const cardsConfig = await readJson(paths.cards, { cards: [], aliases: {} });
  const queryConfig = await readJson(paths.queries, { queries: [] });
  const historyConfig = await readJson(paths.history, {});
  return { cardsConfig, queryConfig, historyConfig };
}

export function mergePosts(oldPosts, discovered, now, storageHorizonHours = 192) {
  const cutoff = now.getTime() - storageHorizonHours * 3600_000;

  return [...oldPosts, ...discovered]
    .filter(p => {
      if (!p?.id || !p?.createdAt) return false;
      const t = new Date(p.createdAt).getTime();
      return Number.isFinite(t) && t >= cutoff && t <= now.getTime() + 3600_000;
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export async function saveSnapshot({
  now,
  posts,
  cardsConfig,
  queryConfig,
  state,
  discoveredThisRun = 0,
  errors = [],
  backfill = null
}) {
  const windows = buildRankings(posts, cardsConfig.cards, now);
  const oldest = posts.length ? posts.at(-1).createdAt : null;
  const newest = posts.length ? posts[0].createdAt : null;
  const firstSuccessfulCollectionAt = state.firstSuccessfulCollectionAt || (posts.length ? now.toISOString() : null);

  const rankings = {
    generatedAt: now.toISOString(),
    source: {
      platform: 'X',
      discovery: 'Yahoo!リアルタイム検索（公開Xポスト）',
      xApiUsed: false,
      historicalBackfill: true,
      scope: '取得できた公開X検索ヒットのうち、本文またはトレード画像から「求/希望」と「譲/出/提供」を判定できたもの',
      note: '初回から直近7日を遡って取得し、その後も定期更新・日次補完します。本文に加えてGameWith等のトレード画像メーカー画像もOCR解析します。件数はYahoo!リアルタイム検索で取得した検索ヒットベースであり、X全体のユニーク投稿総数を表すものではありません。Yahoo!リアルタイム検索に出ない投稿、非公開投稿、取得できない画像、OCRで判別できない画像は含まれません。'
    },
    cards: {
      count: cardsConfig.cards.length,
      rarity: cardsConfig.rarity,
      type: cardsConfig.type,
      updatedAt: cardsConfig.updatedAt
    },
    coverage: {
      firstSuccessfulCollectionAt,
      oldestPostAt: oldest,
      newestPostAt: newest,
      storedPosts: posts.length,
      discoveredThisRun,
      queryCount: queryConfig.queries.length,
      errors,
      history: state.lastBackfill ?? backfill ?? null,
      imageOcr: state.imageOcr ?? null
    },
    windows
  };

  const storedPosts = posts.map(p => ({
  id: p.id,
  createdAt: p.createdAt,
  demand: p.demand ?? [],
  supply: p.supply ?? []
}));
await writeJson(paths.posts, storedPosts);
  await writeJson(paths.rankings, rankings);
  await writeJson(paths.state, { ...state, firstSuccessfulCollectionAt, lastRunAt: now.toISOString(), lastRunDiscovered: discoveredThisRun, lastRunErrors: errors });
  return rankings;
}
