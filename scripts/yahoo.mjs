import { cleanText, normalizeXUrl, parseTradeText, snowflakeToIso } from './lib.mjs';
import { mergeMentionCounts } from './image-ocr.mjs';

export const YAHOO_TIMELINE_ENDPOINT = 'https://search.yahoo.co.jp/realtime/api/v1/pagination';

const DEFAULT_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
  'accept': 'application/json, text/plain, */*',
  'accept-language': 'ja,en-US;q=0.8,en;q=0.6',
  'referer': 'https://search.yahoo.co.jp/realtime/search'
};

export function stripYahooHighlight(value = '') {
  return cleanText(String(value)
    .replace(/\t\s*START\s*\t/gi, '')
    .replace(/\t\s*END\s*\t/gi, '')
    .replace(/\\t\s*START\s*\\t/gi, '')
    .replace(/\\t\s*END\s*\\t/gi, ''));
}

export function createdAtFromEntry(entry = {}) {
  const n = Number(entry.createdAt);
  if (Number.isFinite(n) && n > 0) {
    const ms = n > 10_000_000_000 ? n : n * 1000;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return entry.id ? snowflakeToIso(String(entry.id)) : null;
}

export function parseYahooTimelineEntry(entry, query, cards, aliases = {}) {
  if (!entry?.id) return null;
  const id = String(entry.id);
  const createdAt = createdAtFromEntry(entry);
  if (!createdAt) return null;

  const body = stripYahooHighlight(entry.displayTextBody ?? entry.text ?? '');
  const parsed = parseTradeText(body, cards, aliases);
  if (!parsed.explicit || (parsed.demand.length === 0 && parsed.supply.length === 0)) return null;

  const candidateUrl = normalizeXUrl(entry.url) || (entry.screenName ? `https://x.com/${entry.screenName}/status/${id}` : null);
  if (!candidateUrl) return null;

  return {
    id,
    url: candidateUrl,
    author: entry.screenName ?? null,
    createdAt,
    demand: parsed.demand,
    supply: parsed.supply,
    query
  };
}


export async function parseYahooTimelineEntryWithImages(entry, query, cards, aliases = {}, imageOcr = null) {
  if (!entry?.id) return null;
  const id = String(entry.id);
  const createdAt = createdAtFromEntry(entry);
  if (!createdAt) return null;

  const body = stripYahooHighlight(entry.displayTextBody ?? entry.text ?? '');
  const textParsed = parseTradeText(body, cards, aliases);
  let imageParsed = { demand: [], supply: [], explicit: false, urls: [] };

  if (imageOcr) {
    imageParsed = await imageOcr.parseEntryImages(entry, body);
  }

  const demand = mergeMentionCounts(textParsed.demand, imageParsed.demand);
  const supply = mergeMentionCounts(textParsed.supply, imageParsed.supply);
  const explicit = textParsed.explicit || imageParsed.explicit;
  if (!explicit || (demand.length === 0 && supply.length === 0)) return null;

  const candidateUrl = normalizeXUrl(entry.url) || (entry.screenName ? `https://x.com/${entry.screenName}/status/${id}` : null);
  if (!candidateUrl) return null;

  return {
    id,
    url: candidateUrl,
    author: entry.screenName ?? null,
    createdAt,
    demand,
    supply,
    query,
    parsedFrom: textParsed.explicit && imageParsed.explicit ? 'text+image' : imageParsed.explicit ? 'image' : 'text',
    imageCount: imageParsed.urls?.length ?? 0
  };
}

export async function parseYahooTimelineResponseWithImages(data, query, cards, aliases = {}, imageOcr = null) {
  const timeline = data?.timeline ?? {};
  const entries = Array.isArray(timeline.entry) ? timeline.entry : [];
  const posts = [];
  for (const entry of entries) {
    const post = await parseYahooTimelineEntryWithImages(entry, query, cards, aliases, imageOcr);
    if (post) posts.push(post);
  }
  const nextCursor = timeline.head?.oldestTweetId ? String(timeline.head.oldestTweetId) : (entries.at(-1)?.id ? String(entries.at(-1).id) : null);
  return { entries, posts, nextCursor, head: timeline.head ?? {} };
}
export function parseYahooTimelineResponse(data, query, cards, aliases = {}) {
  const timeline = data?.timeline ?? {};
  const entries = Array.isArray(timeline.entry) ? timeline.entry : [];
  const posts = entries.map(e => parseYahooTimelineEntry(e, query, cards, aliases)).filter(Boolean);
  const nextCursor = timeline.head?.oldestTweetId ? String(timeline.head.oldestTweetId) : (entries.at(-1)?.id ? String(entries.at(-1).id) : null);
  return { entries, posts, nextCursor, head: timeline.head ?? {} };
}

export async function fetchYahooTimelinePage(query, {
  cursor = null,
  results = 40,
  retryCount = 2,
  timeoutMs = 20_000,
  fetchImpl = fetch
} = {}) {
  const params = new URLSearchParams({ p: query, results: String(Math.max(1, Math.min(40, results))) });
  if (cursor) params.set('oldestTweetId', cursor);
  const url = `${YAHOO_TIMELINE_ENDPOINT}?${params}`;

  let lastError;
  for (let attempt = 0; attempt <= retryCount; attempt++) {
    try {
      const res = await fetchImpl(url, {
        headers: DEFAULT_HEADERS,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastError = err;
      if (attempt >= retryCount) break;
      await sleep(1200 * (attempt + 1));
    }
  }
  throw lastError;
}

export async function collectYahooQuery({
  query,
  cards,
  aliases = {},
  since,
  maxPages = 3,
  resultsPerPage = 40,
  throttleMs = 450,
  retryCount = 2,
  fetchImpl = fetch,
  onPage = null,
  imageOcr = null
}) {
  const sinceMs = since ? new Date(since).getTime() : -Infinity;
  const byId = new Map();
  let cursor = null;
  let pages = 0;
  let totalEntries = 0;
  let oldestSeenAt = null;
  let reachedCutoff = false;
  let exhausted = false;

  for (let page = 0; page < maxPages; page++) {
    const data = await fetchYahooTimelinePage(query, { cursor, results: resultsPerPage, retryCount, fetchImpl });
    const parsed = imageOcr
      ? await parseYahooTimelineResponseWithImages(data, query, cards, aliases, imageOcr)
      : parseYahooTimelineResponse(data, query, cards, aliases);
    pages++;
    totalEntries += parsed.entries.length;

    let pageOldestMs = Infinity;
    for (const entry of parsed.entries) {
      const at = createdAtFromEntry(entry);
      if (!at) continue;
      const ms = new Date(at).getTime();
      if (ms < pageOldestMs) pageOldestMs = ms;
      if (!oldestSeenAt || ms < new Date(oldestSeenAt).getTime()) oldestSeenAt = at;
    }
    for (const post of parsed.posts) byId.set(post.id, post);

    onPage?.({ query, page: pages, entries: parsed.entries.length, parsedPosts: parsed.posts.length, oldestSeenAt });

    if (Number.isFinite(pageOldestMs) && pageOldestMs <= sinceMs) {
      reachedCutoff = true;
      break;
    }
    if (!parsed.entries.length || !parsed.nextCursor || parsed.nextCursor === cursor) {
      exhausted = true;
      break;
    }
    cursor = parsed.nextCursor;
    if (throttleMs > 0) await sleep(throttleMs);
  }

  const capped = !reachedCutoff && !exhausted && pages >= maxPages;
  return {
    posts: [...byId.values()],
    stats: { query, pages, totalEntries, parsedPosts: byId.size, oldestSeenAt, reachedCutoff, exhausted, capped }
  };
}

export function makeCardBackfillQueries(cards, aliases = {}) {
  const namesByCanonical = new Map(cards.map(c => [c, new Set([c])]));
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (namesByCanonical.has(canonical)) namesByCanonical.get(canonical).add(alias);
  }
  const out = [];
  for (const [canonical, names] of namesByCanonical) {
    for (const name of names) {
      out.push({
        canonical,
        searchName: name,
        query: `ポケポケ ${name} (求 希望) (譲 出 提供)`
      });
    }
  }
  return out;
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
