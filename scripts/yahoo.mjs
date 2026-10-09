import { cleanText, normalizeXUrl, parseTradeText, snowflakeToIso } from './lib.mjs';
import { mergeMentionCounts } from './image-ocr.mjs';

export const YAHOO_TIMELINE_ENDPOINT = 'https://search.yahoo.co.jp/realtime/api/v1/pagination';

const DEFAULT_HEADERS = {
  'accept': 'application/json, text/plain, */*',
  'accept-language': 'ja,en-US;q=0.8,en;q=0.6',
};

export function stripYahooHighlight(value = '') {
  return cleanText(String(value)
    .replace(/\t\s*START\s*\t/gi, '')
    .replace(/\t\s*END\s*\t/gi, '')
    .replace(/\\t\s*START\s*\\t/gi, '')
    .replace(/\\t\s*END\s*\\t/gi, ''));
}

export function isCardSalePost(rawText = '') {
  let text = String(rawText).normalize('NFKC');

  // Allow trade posts that explicitly say they do NOT buy/sell.
  text = text
    .replace(/(?:販売|売買|買取|買い取り|購入)\s*(?:不可|NG|なし|無し|しません|してません|ではありません|ではない|お断り)/gi, ' ')
    .replace(/(?:現金|金銭)\s*(?:不可|NG|なし|無し|しません|ではありません|ではない)/gi, ' ');

  const saleWords =
    /(?:販売|売却|売ります|売る予定|買取|買い取り|買います|購入希望|購入します|出品|即決|価格|値段|値下げ|相場|現金|銀行振込|振込|PayPay|ペイペイ|メルカリ|ヤフオク|ラクマ|通販|送料|買取表)/i;
  const money =
    /(?:[¥￥]\s*[1-9][0-9,]*|[1-9][0-9,]*\s*円|[1-9][0-9]*(?:\.[0-9]+)?\s*万円)/i;

  return saleWords.test(text) || money.test(text);
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
  if (isCardSalePost(body)) return null;
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
  // Reject monetary buying/selling before spending any OCR time.
  if (isCardSalePost(body)) return null;
  const textParsed = parseTradeText(body, cards, aliases);
  let imageParsed = {
    demand: [],
    supply: [],
    explicit: false,
    urls: [],
    gameWithDetected: false,
    authoritative: false
  };

  if (imageOcr) {
    imageParsed = await imageOcr.parseEntryImages(entry, body);
  }

  let demand;
  let supply;
  let explicit;
  let parsedFrom;

  // GameWith trade-maker images are authoritative. If text and image disagree,
  // never mix text into the image result. If the image is detected but cannot
  // be verified with enough confidence, skip the post rather than falling back
  // to text. This deliberately favors precision over recall.
  if (imageParsed.gameWithDetected || imageParsed.authoritative) {
    demand = imageParsed.demand ?? [];
    supply = imageParsed.supply ?? [];
    explicit = Boolean(imageParsed.explicit);
    parsedFrom = 'gamewith-image-priority';
  } else {
    demand = mergeMentionCounts(textParsed.demand, imageParsed.demand);
    supply = mergeMentionCounts(textParsed.supply, imageParsed.supply);
    explicit = textParsed.explicit || imageParsed.explicit;
    parsedFrom = textParsed.explicit && imageParsed.explicit
      ? 'text+image'
      : imageParsed.explicit
        ? 'image'
        : 'text';
  }

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
    parsedFrom,
    imageCount: imageParsed.urls?.length ?? 0,
    gameWithDetected: Boolean(imageParsed.gameWithDetected),
    imageAuthoritative: Boolean(imageParsed.authoritative)
  };
}

export async function parseYahooTimelineResponseWithImages(data, query, cards, aliases = {}, imageOcr = null, cachedPostsById = null) {
  const timeline = data?.timeline ?? {};
  const entries = Array.isArray(timeline.entry) ? timeline.entry : [];
  const posts = [];
  for (const entry of entries) {
    const id = String(entry?.id ?? '');
    const cached = cachedPostsById?.get(id);
    const body = stripYahooHighlight(entry?.displayTextBody ?? entry?.text ?? '');
    // Reused entries still contribute exactly as before. Reject newly detected
    // sale text; never reuse a cached positive when the current text is for sale.
    const post = cached && !isCardSalePost(body)
      ? cached
      : await parseYahooTimelineEntryWithImages(entry, query, cards, aliases, imageOcr);
    if (post) {
      posts.push(post);
      cachedPostsById?.set(id, post);
    }
  }
  const nextCursor = timeline.head?.oldestTweetId
    ? String(timeline.head.oldestTweetId)
    : (entries.at(-1)?.id ? String(entries.at(-1).id) : null);
  return { entries, posts, nextCursor, head: timeline.head ?? {} };
}

export function parseYahooTimelineResponse(data, query, cards, aliases = {}) {
  const timeline = data?.timeline ?? {};
  const entries = Array.isArray(timeline.entry) ? timeline.entry : [];
  const posts = entries.map(e => parseYahooTimelineEntry(e, query, cards, aliases)).filter(Boolean);
  const nextCursor = timeline.head?.oldestTweetId
    ? String(timeline.head.oldestTweetId)
    : (entries.at(-1)?.id ? String(entries.at(-1).id) : null);
  return { entries, posts, nextCursor, head: timeline.head ?? {} };
}

export async function fetchYahooTimelinePage(query, {
  cursor = null,
  results = 40,
  retryCount = 0,
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
      if (res.status === 403 || res.status === 429) throw new Error(`ACCESS_BLOCKED HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastError = err;
      if (String(err?.message ?? err).includes('ACCESS_BLOCKED')) throw err;
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
  retryCount = 0,
  fetchImpl = fetch,
  onPage = null,
  onRequest = null,
  cachedPostsById = null,
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
    onRequest?.({ query, page: page + 1 });
    const data = await fetchYahooTimelinePage(query, { cursor, results: resultsPerPage, retryCount, fetchImpl });
    const parsed = imageOcr
      ? await parseYahooTimelineResponseWithImages(data, query, cards, aliases, imageOcr, cachedPostsById)
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
