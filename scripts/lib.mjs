import fs from 'node:fs/promises';
import path from 'node:path';

export const TWITTER_EPOCH_MS = 1288834974657n;

export function cleanText(value = '') {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/[\t\r]+/g, ' ')
    .replace(/ +/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function normalizeXUrl(href, base = 'https://search.yahoo.co.jp/') {
  if (!href) return null;
  try {
    const u = new URL(href, base);
    if (u.hostname === 'twitter.com' || u.hostname === 'www.twitter.com') u.hostname = 'x.com';
    if (u.hostname === 'www.x.com') u.hostname = 'x.com';
    const m = u.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
    if (!m) return null;
    return `https://x.com/${m[1]}/status/${m[2]}`;
  } catch {
    return null;
  }
}

export function statusIdFromUrl(url) {
  return url?.match(/\/status\/(\d+)/)?.[1] ?? null;
}

export function authorFromUrl(url) {
  return url?.match(/^https:\/\/x\.com\/([^/]+)\/status\//)?.[1] ?? null;
}

export function snowflakeToIso(id) {
  try {
    const ms = Number((BigInt(id) >> 22n) + TWITTER_EPOCH_MS);
    if (!Number.isFinite(ms)) return null;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function canonicalizeAliases(text, aliases = {}) {
  let out = text;
  for (const [alias, canonical] of Object.entries(aliases)) {
    out = out.replaceAll(alias, canonical);
  }
  return out;
}

export function extractCardMentions(segment, cards, aliases = {}) {
  if (!segment) return [];
  const text = canonicalizeAliases(segment, aliases);
  const found = [];
  const names = [...cards].sort((a, b) => b.length - a.length);

  for (const name of names) {
    // A negative Japanese-character look-ahead prevents short supporter names
    // such as 「カイ」「ハラ」 from matching Pokémon like カイリュー/ハラバリー.
    const re = new RegExp(`${escapeRegExp(name)}(?![ぁ-んァ-ヶー一-龠々])`, 'g');
    for (const match of text.matchAll(re)) {
      const tail = text.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 12);
      const qty = tail.match(/^\s*(?:[×xX＊*]\s*(\d+)|(\d+)\s*枚)/);
      const n = Math.max(1, Math.min(20, Number(qty?.[1] ?? qty?.[2] ?? 1)));
      for (let i = 0; i < n; i++) found.push(name);
    }
  }
  return found;
}

export function parseTradeText(rawText, cards, aliases = {}) {
  const text = cleanText(rawText)
    .replace(/[：﹕]/g, ':')
    .replace(/[）]/g, ')');

  const markerRe = /(求(?:む)?|希望|譲|出|提供)\s*[:)]/g;
  const markers = [...text.matchAll(markerRe)].map(m => ({
    kind: /^(求|希望)/.test(m[1]) ? 'demand' : 'supply',
    start: m.index ?? 0,
    contentStart: (m.index ?? 0) + m[0].length
  }));

  if (!markers.some(m => m.kind === 'demand') || !markers.some(m => m.kind === 'supply')) {
    return { demand: [], supply: [], explicit: false };
  }

  const demand = [];
  const supply = [];
  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i];
    const end = markers[i + 1]?.start ?? text.length;
    const segment = text.slice(marker.contentStart, end);
    const cardsFound = extractCardMentions(segment, cards, aliases);
    (marker.kind === 'demand' ? demand : supply).push(...cardsFound);
  }

  return { demand, supply, explicit: true };
}

export function ratioData(demand, supply) {
  if (demand === 0 && supply === 0) return { ratio: 0, ratioDisplay: '0.00', ratioSort: 0 };
  if (supply === 0) return { ratio: null, ratioDisplay: '∞', ratioSort: 1_000_000_000 + demand };
  const ratio = demand / supply;
  return { ratio, ratioDisplay: ratio.toFixed(2), ratioSort: ratio };
}

export function buildRankings(posts, cards, now = new Date()) {
  const windows = [
    { key: '24h', hours: 24, label: '24時間' },
    { key: '48h', hours: 48, label: '48時間' },
    { key: '168h', hours: 168, label: '1週間' }
  ];

  const out = {};
  for (const w of windows) {
    const cutoff = now.getTime() - w.hours * 3600_000;
    const selected = posts.filter(p => new Date(p.createdAt).getTime() >= cutoff && new Date(p.createdAt).getTime() <= now.getTime() + 3600_000);
    const map = new Map(cards.map(name => [name, { name, demand: 0, supply: 0 }]));
    let totalDemand = 0;
    let totalSupply = 0;

    for (const p of selected) {
      for (const name of p.demand ?? []) {
        if (!map.has(name)) continue;
        map.get(name).demand++;
        totalDemand++;
      }
      for (const name of p.supply ?? []) {
        if (!map.has(name)) continue;
        map.get(name).supply++;
        totalSupply++;
      }
    }

    const rankings = [...map.values()]
      .filter(x => x.demand > 0 || x.supply > 0)
      .map(x => ({ ...x, ...ratioData(x.demand, x.supply), imbalance: x.demand - x.supply }))
      .sort((a, b) => b.ratioSort - a.ratioSort || b.demand - a.demand || a.supply - b.supply || a.name.localeCompare(b.name, 'ja'))
      .map((x, i) => ({ rank: i + 1, ...x }));

    out[w.key] = {
      label: w.label,
      hours: w.hours,
      posts: selected.length,
      totalDemand,
      totalSupply,
      totalRatio: ratioData(totalDemand, totalSupply),
      rankings
    };
  }
  return out;
}

export async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return fallback; }
}

export async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}
