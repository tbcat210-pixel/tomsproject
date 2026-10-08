import { readJson, writeJson, extractCardMentions, cleanText } from './lib.mjs';
import { createCardImageMatcher } from './card-image-matcher.mjs';

const IMAGE_KEY_RE = /(image|img|photo|media|thumbnail|picture|large|orig)/i;
const IMAGE_URL_RE = /\.(?:jpe?g|png|webp)(?:[?#].*)?$/i;
const IMAGE_HOST_RE = /(?:pbs\.twimg\.com|twimg\.com|img\.gamewith\.jp|yimg\.jp)/i;
const DEFAULT_CACHE_VERSION = 10;

export function extractImageUrlsFromEntry(entry = {}) {
  const out = new Set();
  const seen = new Set();

  const visit = (value, key = '', depth = 0) => {
    if (depth > 8 || value == null) return;
    if (typeof value === 'string') {
      const s = value.replace(/\\u002F/g, '/').replace(/&amp;/g, '&');
      if (/^https?:\/\//i.test(s) && (IMAGE_URL_RE.test(s) || IMAGE_HOST_RE.test(s) || IMAGE_KEY_RE.test(key))) {
        try {
          const u = new URL(s);
          if (u.hostname === 'pbs.twimg.com' && u.searchParams.get('format')) {
            u.searchParams.set('name', 'orig');
          }
          out.add(u.toString());
        } catch {
          out.add(s);
        }
      }
      return;
    }
    if (typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const x of value) visit(x, key, depth + 1);
      return;
    }
    for (const [k, v] of Object.entries(value)) visit(v, k, depth + 1);
  };

  visit(entry);
  return [...out];
}

export function normalizeOcrTradeText(value = '') {
  return cleanText(String(value)
    .normalize('NFKC')
    .replace(/[カ力][一ー―−-]ド/g, 'カード')
    .replace(/欲し[ぃい]/g, '欲しい')
    .replace(/出せ[るろ]/g, '出せる')
    .replace(/譲れ[るろ]/g, '譲れる')
    .replace(/[｜|¦]/g, ' ')
    .replace(/[：﹕]/g, ':')
    .replace(/[／]/g, '/')
    .replace(/[・•●]/g, ' ')
    .replace(/([ぁ-んァ-ヶー一-龠々])[ \t]+(?=[ぁ-んァ-ヶー一-龠々])/g, '$1')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' '));
}

function markerKind(raw = '') {
  return /^(欲しい|ほしい|求める|希望カード|求む|求|希望)/.test(raw) ? 'demand' : 'supply';
}

const TRADE_MARKER_RE = /(欲しいカード|ほしいカード|求めるカード|希望カード|求む|求|希望|出せるカード|譲れるカード|提供カード|譲|出|提供)\s*(?::|\)|）|】|\]|$)?/gm;

export function parseTradeImageText(rawText, cards, aliases = {}) {
  const text = normalizeOcrTradeText(rawText);
  if (!text) return { demand: [], supply: [], explicit: false, markers: [] };

  const markers = [...text.matchAll(TRADE_MARKER_RE)].map(m => ({
    raw: m[1],
    kind: markerKind(m[1]),
    start: m.index ?? 0,
    contentStart: (m.index ?? 0) + m[0].length
  }));

  if (!markers.some(m => m.kind === 'demand') || !markers.some(m => m.kind === 'supply')) {
    return { demand: [], supply: [], explicit: false, markers };
  }

  const demand = [];
  const supply = [];
  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i];
    const end = markers[i + 1]?.start ?? text.length;
    const segment = text.slice(marker.contentStart, end);
    const mentions = extractCardMentions(segment, cards, aliases);
    (marker.kind === 'demand' ? demand : supply).push(...mentions);
  }
  return { demand, supply, explicit: true, markers };
}

export function parseSingleSideTradeText(rawText, cards, aliases = {}) {
  const text = normalizeOcrTradeText(rawText);
  if (!text) return { demand: [], supply: [], explicit: false, kind: null };

  const markers = [...text.matchAll(TRADE_MARKER_RE)].map(m => ({
    raw: m[1],
    kind: markerKind(m[1]),
    start: m.index ?? 0,
    contentStart: (m.index ?? 0) + m[0].length
  }));
  if (!markers.length) return { demand: [], supply: [], explicit: false, kind: null };

  const kinds = new Set(markers.map(m => m.kind));
  if (kinds.size !== 1) return { demand: [], supply: [], explicit: false, kind: null };
  const kind = markers[0].kind;

  const found = [];
  for (let i = 0; i < markers.length; i++) {
    const end = markers[i + 1]?.start ?? text.length;
    found.push(...extractCardMentions(text.slice(markers[i].contentStart, end), cards, aliases));
  }

  return {
    demand: kind === 'demand' ? found : [],
    supply: kind === 'supply' ? found : [],
    explicit: found.length > 0,
    kind
  };
}

function listCounts(xs = []) {
  const m = new Map();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
}

function countsToList(m) {
  const out = [];
  for (const [name, n] of m) {
    for (let i = 0; i < n; i++) out.push(name);
  }
  return out;
}

export function mergeMentionCounts(a = [], b = []) {
  const am = listCounts(a);
  const bm = listCounts(b);
  const out = new Map();
  for (const name of new Set([...am.keys(), ...bm.keys()])) {
    out.set(name, Math.max(am.get(name) ?? 0, bm.get(name) ?? 0));
  }
  return countsToList(out);
}

export function mergeMentionGroups(groups = []) {
  let merged = [];
  for (const group of groups) merged = mergeMentionCounts(merged, group);
  return merged;
}


function normalizeCardTitleText(value = '') {
  return String(value)
    .normalize('NFKC')
    .replace(/[―−‐‑–—]/g, 'ー')
    .replace(/[｜|¦]/g, '')
    .replace(/[\s・･·•●★☆※:：/／\\()[\]{}【】「」『』<>＜＞"'`´^~_+=*×xX0-9A-Za-z]+/g, '')
    .replace(/[^ぁ-んァ-ヶー一-龠々]/g, '');
}

function levenshteinDistance(a, b) {
  const aa = [...a];
  const bb = [...b];
  if (!aa.length) return bb.length;
  if (!bb.length) return aa.length;
  const prev = Array.from({ length: bb.length + 1 }, (_, i) => i);
  for (let i = 0; i < aa.length; i++) {
    let diag = prev[0];
    prev[0] = i + 1;
    for (let j = 0; j < bb.length; j++) {
      const old = prev[j + 1];
      prev[j + 1] = Math.min(
        prev[j + 1] + 1,
        prev[j] + 1,
        diag + (aa[i] === bb[j] ? 0 : 1)
      );
      diag = old;
    }
  }
  return prev[bb.length];
}

function titleTokens(rawText = '') {
  const raw = String(rawText).normalize('NFKC');
  const out = new Set();

  for (const line of raw.split(/\r?\n/)) {
    const whole = normalizeCardTitleText(line);
    if (whole) out.add(whole);

    for (const part of line.split(/[\s　,，.。:：;；/／\\|｜()[\]{}【】「」『』<>＜＞"'`´^~_+=*×xX]+/)) {
      const token = normalizeCardTitleText(part);
      if (token) out.add(token);
    }
  }
  return [...out];
}

function buildCardTitleVariants(cards = [], aliases = {}) {
  const variants = [];
  const seen = new Set();

  for (const name of cards) {
    const normalized = normalizeCardTitleText(name);
    const key = `${normalized}\u0000${name}`;
    if (normalized && !seen.has(key)) {
      seen.add(key);
      variants.push({ raw: name, normalized, canonical: name });
    }
  }
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (!cards.includes(canonical)) continue;
    const normalized = normalizeCardTitleText(alias);
    const key = `${normalized}\u0000${canonical}`;
    if (normalized && !seen.has(key)) {
      seen.add(key);
      variants.push({ raw: alias, normalized, canonical });
    }
  }
  return variants;
}

function scoreGameWithCardTitle(rawText, cards, aliases = {}, confidence = 0) {
  const tokens = titleTokens(rawText).filter(x => [...x].length >= 2);
  if (!tokens.length) return null;

  const variants = buildCardTitleVariants(cards, aliases);
  const matches = [];

  for (const token of tokens) {
    const tokenLen = [...token].length;

    for (const variant of variants) {
      const target = variant.normalized;
      const targetLen = [...target].length;
      if (!targetLen) continue;

      // Exact whole-token matches are strong. This deliberately avoids
      // accepting short supporter names that only occur inside a Pokémon name.
      if (token === target) {
        matches.push({
          canonical: variant.canonical,
          exact: true,
          distance: 0,
          score: 1,
          confidence: Number(confidence) || 0,
          token,
          target
        });
        continue;
      }

      // Short names (カイ/マオ/ハラ/etc.) are exact-only because a single
      // OCR error can easily turn an unrelated Pokémon name into a supporter.
      if (targetLen <= 3) continue;

      const lengthGap = Math.abs(tokenLen - targetLen);
      const maxGap = targetLen >= 10 ? 2 : 1;
      if (lengthGap > maxGap) continue;

      const distance = levenshteinDistance(token, target);
      const allowed = targetLen >= 10 ? 2 : 1;
      if (distance > allowed) continue;

      const score = 1 - distance / Math.max(tokenLen, targetLen);
      const minScore = targetLen >= 10 ? 0.86 : targetLen >= 6 ? 0.88 : 0.80;
      if (score < minScore) continue;

      matches.push({
        canonical: variant.canonical,
        exact: false,
        distance,
        score,
        confidence: Number(confidence) || 0,
        token,
        target
      });
    }
  }

  matches.sort((a, b) =>
    Number(b.exact) - Number(a.exact) ||
    a.distance - b.distance ||
    b.score - a.score ||
    b.confidence - a.confidence ||
    [...b.target].length - [...a.target].length ||
    a.canonical.localeCompare(b.canonical, 'ja')
  );

  const best = matches[0];
  if (!best) return null;

  const second = matches.find(x => x.canonical !== best.canonical);
  if (second) {
    if (best.exact === second.exact &&
        best.distance === second.distance &&
        Math.abs(best.score - second.score) < 0.08) {
      return null;
    }
  }
  return best;
}

export function chooseGameWithCardConsensus(results = [], cards = [], aliases = {}) {
  const scored = results
    .map(r => scoreGameWithCardTitle(r?.text ?? '', cards, aliases, r?.confidence ?? 0))
    .filter(Boolean);
  if (!scored.length) return null;

  const groups = new Map();
  for (const item of scored) {
    const g = groups.get(item.canonical) ?? {
      canonical: item.canonical,
      votes: 0,
      exactVotes: 0,
      scoreSum: 0,
      confidenceSum: 0,
      bestDistance: Infinity
    };
    g.votes++;
    if (item.exact) g.exactVotes++;
    g.scoreSum += item.score;
    g.confidenceSum += item.confidence;
    g.bestDistance = Math.min(g.bestDistance, item.distance);
    groups.set(item.canonical, g);
  }

  const ranked = [...groups.values()]
    .map(g => ({
      ...g,
      avgScore: g.scoreSum / g.votes,
      avgConfidence: g.confidenceSum / g.votes
    }))
    .sort((a, b) =>
      b.exactVotes - a.exactVotes ||
      b.votes - a.votes ||
      b.avgScore - a.avgScore ||
      b.avgConfidence - a.avgConfidence ||
      a.bestDistance - b.bestDistance ||
      a.canonical.localeCompare(b.canonical, 'ja')
    );

  const best = ranked[0];
  const second = ranked[1];

  // Very short supporter names are the easiest false positives, so even an
  // exact short-name OCR needs two independent preprocessing passes.
  if (best.exactVotes > 0) {
    const canonicalLength = [...normalizeCardTitleText(best.canonical)].length;
    const exactMinVotes = canonicalLength <= 3 ? 3 : 2;
    if (best.exactVotes < exactMinVotes) return null;
    if (second && second.exactVotes > 0 && second.exactVotes >= best.exactVotes - 1) return null;
    return best.canonical;
  }

  // Fuzzy-only results require agreement across independent preprocessing
  // passes. Two-character OCR slips on long titles need even stronger support.
  const minVotes = best.bestDistance >= 2 ? 4 : 3;
  if (best.votes < minVotes) return null;

  if (second) {
    if (second.votes >= best.votes) return null;
    if (second.votes === best.votes - 1 && Math.abs(best.avgScore - second.avgScore) < 0.08) return null;
  }

  return best.canonical;
}


export function hasExplicitStar2Marker(rawText = '') {
  const text = String(rawText).normalize('NFKC');
  return /(?:★|☆)\s*2|☆☆|星\s*2|2\s*(?:star|stars)/i.test(text);
}

export function hasCardSaleMarker(rawText = '') {
  let text = String(rawText).normalize('NFKC');

  // Do not reject explicit "not for sale / no buying" disclaimers.
  text = text
    .replace(/(?:販売|売買|買取|買い取り|購入)\s*(?:不可|NG|なし|無し|しません|してません|ではありません|ではない|お断り)/gi, ' ')
    .replace(/(?:現金|金銭)\s*(?:不可|NG|なし|無し|しません|ではありません|ではない)/gi, ' ');

  const saleWords =
    /(?:販売|売却|売ります|売る予定|買取|買い取り|買います|購入希望|購入します|出品|即決|価格|値段|値下げ|相場|現金|銀行振込|振込|PayPay|ペイペイ|メルカリ|ヤフオク|ラクマ|通販|送料|買取表)/i;
  const money =
    /(?:[¥￥]\s*[1-9][0-9,]*|[1-9][0-9,]*\s*円|[1-9][0-9]*(?:\.[0-9]+)?\s*万円)/i;

  return saleWords.test(text) || money.test(text);
}

function badgeDigits(rawText = '') {
  return String(rawText).normalize('NFKC').replace(/[^0-9]/g, '');
}

export function verifyGameWithStar2Badge(results = [], metrics = {}) {
  const darkRatio = Number(metrics?.darkRatio ?? 0);
  const yellowRatio = Number(metrics?.yellowRatio ?? 0);

  // The GameWith rarity badge has a dark rounded rectangle plus a yellow star.
  // Require both visual features before trusting OCR of the small digit.
  if (darkRatio < 0.18 || yellowRatio < 0.0025) return false;

  let twoVotes = 0;
  let otherVotes = 0;
  for (const result of results) {
    const digits = badgeDigits(result?.text ?? '');
    if (!digits) continue;
    if (digits.includes('2')) twoVotes++;
    else if (/[13]/.test(digits)) otherVotes++;
  }

  // Five-pass mode requires a 3-vote majority and a clear margin over ★1/★3.
  // Three-pass compatibility mode retains a 2-vote requirement.
  const requiredTwoVotes = results.length >= 5 ? 3 : 2;
  const requiredMargin = results.length >= 5 ? 2 : 1;
  return twoVotes >= requiredTwoVotes && twoVotes - otherVotes >= requiredMargin;
}

async function prepareBadgeVariant(raw, {
  threshold = null,
  clahe = false,
  negate = false
} = {}) {
  const { default: sharp } = await import('sharp');
  let pipeline = sharp(raw).grayscale();

  if (clahe) pipeline = pipeline.clahe({ width: 3, height: 3, maxSlope: 4 });
  pipeline = pipeline
    .resize({ width: 620, withoutEnlargement: false, kernel: 'lanczos3' })
    .normalize()
    .sharpen({ sigma: 0.7 });

  if (negate) pipeline = pipeline.negate();
  if (threshold != null) pipeline = pipeline.threshold(threshold);

  const body = await pipeline.png().toBuffer();
  return sharp(body)
    .extend({ top: 34, bottom: 34, left: 44, right: 44, background: '#ffffff' })
    .png()
    .toBuffer();
}

export function extractGameWithCardMentions(rawText, cards, aliases = {}) {
  // Retained for compatibility with tests and older callers. In v6 each
  // GameWith card cell is recognized independently and consensus is preferred.
  const lines = String(rawText).split(/\r?\n/).filter(Boolean);
  const out = [];
  for (const line of lines) {
    const match = scoreGameWithCardTitle(line, cards, aliases, 100);
    if (match?.exact) out.push(match.canonical);
  }
  return out;
}

function contiguousRuns(scores, minScore = 0.40, minRows = 5) {
  const out = [];
  let start = -1;
  for (let i = 0; i <= scores.length; i++) {
    const hit = i < scores.length && scores[i] >= minScore;
    if (hit && start < 0) start = i;
    if ((!hit || i === scores.length) && start >= 0) {
      const end = i - 1;
      if (end - start + 1 >= minRows) {
        const slice = scores.slice(start, end + 1);
        out.push({
          start,
          end,
          score: slice.reduce((a, b) => a + b, 0) / slice.length
        });
      }
      start = -1;
    }
  }
  return out;
}

export async function detectGameWithTradeLayout(bytes) {
  const { default: sharp } = await import('sharp');
  const meta = await sharp(bytes, { failOn: 'none', limitInputPixels: 80_000_000 }).metadata();
  if (!meta.width || !meta.height) return null;

  const analysisWidth = Math.min(900, meta.width);
  const { data, info } = await sharp(bytes, { failOn: 'none', limitInputPixels: 80_000_000 })
    .resize({ width: analysisWidth, withoutEnlargement: true, fastShrinkOnLoad: false })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  if (channels < 3 || width < 240 || height < 180) return null;

  const pinkScores = new Array(height).fill(0);
  const blueScores = new Array(height).fill(0);
  const darkScores = new Array(height).fill(0);
  const step = width > 700 ? 2 : 1;
  const sampled = Math.ceil(width / step);

  for (let y = 0; y < height; y++) {
    let pink = 0;
    let blue = 0;
    let dark = 0;
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * channels;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];

      if (r >= 175 && r - g >= 25 && b >= 65 && ((r + b) / 2 - g) >= 18) pink++;
      if (b >= 145 && g >= 90 && b - r >= 35 && g - r >= 25) blue++;
      if (r <= 28 && g <= 28 && b <= 28) dark++;
    }
    pinkScores[y] = pink / sampled;
    blueScores[y] = blue / sampled;
    darkScores[y] = dark / sampled;
  }

  const minRows = Math.max(5, Math.round(height * 0.005));
  const pinkRuns = contiguousRuns(pinkScores, 0.36, minRows);
  const blueRuns = contiguousRuns(blueScores, 0.36, minRows);
  let best = null;

  for (const pink of pinkRuns) {
    for (const blue of blueRuns) {
      if (blue.start <= pink.end) continue;
      const gap = blue.start - pink.end;
      if (gap < height * 0.05 || gap > height * 0.72) continue;
      const score = pink.score + blue.score;
      if (!best || score > best.score) best = { pink, blue, score };
    }
  }
  if (!best) return null;

  const darkRuns = contiguousRuns(darkScores, 0.88, Math.max(8, Math.round(height * 0.01)));
  const lowerBlack = darkRuns.find(run => run.start > best.blue.end + height * 0.08);
  const contentBottom = lowerBlack ? lowerBlack.start / height : 1;

  return {
    type: 'gamewith-trade-maker',
    confidence: Math.min(1, best.score / 1.5),
    pinkTop: best.pink.start / height,
    pinkBottom: (best.pink.end + 1) / height,
    blueTop: best.blue.start / height,
    blueBottom: (best.blue.end + 1) / height,
    contentBottom
  };
}

async function prepareTitleVariant(raw, {
  width = 1080,
  clahe = false,
  threshold = null,
  linear = null
} = {}) {
  const { default: sharp } = await import('sharp');
  let pipeline = sharp(raw)
    .grayscale();

  if (clahe) pipeline = pipeline.clahe({ width: 3, height: 3, maxSlope: 4 });
  pipeline = pipeline.normalize().sharpen({ sigma: 0.8 });
  if (linear) pipeline = pipeline.linear(linear.a, linear.b);
  if (threshold != null) pipeline = pipeline.threshold(threshold);

  const body = await pipeline
    .resize({ width, withoutEnlargement: false, kernel: 'lanczos3' })
    .png()
    .toBuffer();

  return sharp(body)
    .extend({ top: 22, bottom: 22, left: 34, right: 34, background: '#ffffff' })
    .png()
    .toBuffer();
}

export function estimateGameWithRowCount(sectionHeight, colPitch, rowPitch, maxRows = 12) {
  const height = Number(sectionHeight);
  const col = Number(colPitch);
  const pitch = Number(rowPitch);
  if (!Number.isFinite(height) || !Number.isFinite(col) || !Number.isFinite(pitch) ||
      height <= 0 || col <= 0 || pitch <= 0) return 0;

  // A real slot needs enough room for the lower-left rarity badge. Using the
  // badge position instead of round(sectionHeight / rowPitch) prevents the
  // last row from disappearing on dense 7+ row maker images.
  const badgeOffset = col * 1.02;
  if (height < badgeOffset + 14) return 0;
  return clamp(
    Math.floor((height - badgeOffset - 1) / pitch) + 1,
    1,
    Math.max(1, maxRows)
  );
}

export async function buildGameWithCardCells(bytes, layout, {
  upscaleMinWidth = 2600,
  upscaleMaxWidth = 4200,
  passesPerCard = 7,
  badgePasses = 5
} = {}) {
  const { default: sharp } = await import('sharp');
  const meta = await sharp(bytes, { failOn: 'none', limitInputPixels: 80_000_000 }).metadata();
  const sourceWidth = meta.width ?? 0;
  const sourceHeight = meta.height ?? 0;
  if (!sourceWidth || !sourceHeight) return [];

  const targetWidth = Math.min(
    upscaleMaxWidth,
    sourceWidth < upscaleMinWidth ? Math.max(sourceWidth * 3, upscaleMinWidth) : sourceWidth
  );

  const prepared = await sharp(bytes, { failOn: 'none', limitInputPixels: 80_000_000 })
    .resize({ width: targetWidth, withoutEnlargement: false, fastShrinkOnLoad: false, kernel: 'lanczos3' })
    .png()
    .toBuffer();

  const preparedMeta = await sharp(prepared).metadata();
  const w = preparedMeta.width ?? targetWidth;
  const h = preparedMeta.height ?? Math.round(sourceHeight * targetWidth / sourceWidth);

  const demandTop = Math.round(layout.pinkBottom * h);
  const demandBottom = Math.round(layout.blueTop * h);
  const supplyTop = Math.round(layout.blueBottom * h);
  const supplyBottom = Math.max(supplyTop + 1, Math.round((layout.contentBottom ?? 1) * h));

  const colPitch = w / 8;
  const rowPitch = colPitch * 1.36;

  const cells = [];
  const addSection = async (kind, sectionTop, sectionBottom) => {
    const sectionHeight = Math.max(0, sectionBottom - sectionTop);
    const rows = estimateGameWithRowCount(sectionHeight, colPitch, rowPitch, 12);

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < 8; col++) {
        // Reuse the proven v5 occupancy window before running expensive OCR.
        // It reliably separates filled GameWith card slots from pale empty slots.
        const occupancyLeft = Math.max(0, Math.round(col * colPitch + colPitch * 0.08));
        const occupancyTop = Math.max(sectionTop, Math.round(sectionTop + colPitch * 0.08 + row * rowPitch));
        const occupancyWidth = Math.max(40, Math.min(w - occupancyLeft, Math.round(colPitch * 0.84)));
        const occupancyHeight = Math.max(22, Math.min(sectionBottom - occupancyTop, Math.round(colPitch * 0.16)));
        if (occupancyWidth < 40 || occupancyHeight < 18 || occupancyTop >= sectionBottom) continue;

        const occupancyRaw = await sharp(prepared)
          .extract({ left: occupancyLeft, top: occupancyTop, width: occupancyWidth, height: occupancyHeight })
          .grayscale()
          .png()
          .toBuffer();
        const occupancyStats = await sharp(occupancyRaw).stats();
        const occupancyChannel = occupancyStats.channels?.[0];

        // Dense maker images sometimes have very short/bright titles. Checking
        // only the title strip can mistake a real slot for the pale background.
        // Also sample the illustration/body area; an actual card has strong
        // texture there while an empty slot remains nearly flat.
        const bodyTop = Math.max(
          sectionTop,
          Math.round(sectionTop + colPitch * 0.26 + row * rowPitch)
        );
        const bodyHeight = Math.max(28, Math.min(
          sectionBottom - bodyTop,
          Math.round(colPitch * 0.60)
        ));
        let bodyEntropy = 0;
        let bodyStdev = 0;
        if (bodyTop < sectionBottom && bodyHeight >= 18) {
          const bodyRaw = await sharp(prepared)
            .extract({
              left: occupancyLeft,
              top: bodyTop,
              width: occupancyWidth,
              height: bodyHeight
            })
            .grayscale()
            .png()
            .toBuffer();
          const bodyStats = await sharp(bodyRaw).stats();
          bodyEntropy = bodyStats.entropy ?? 0;
          bodyStdev = bodyStats.channels?.[0]?.stdev ?? 0;
        }

        const titleOccupied =
          (occupancyStats.entropy ?? 0) >= 2.2 &&
          (occupancyChannel?.stdev ?? 0) >= 10;
        const bodyOccupied = bodyEntropy >= 3.2 && bodyStdev >= 18;
        if (!titleOccupied && !bodyOccupied) continue;

        // Verify the GameWith rarity badge before spending OCR time on the
        // card name. The badge sits at the lower-left of every maker slot.
        const badgeLeft = Math.max(0, Math.round(col * colPitch + colPitch * 0.025));
        const badgeTop = Math.max(
          sectionTop,
          Math.round(sectionTop + colPitch * 1.08 + row * rowPitch)
        );
        const badgeWidth = Math.max(26, Math.min(w - badgeLeft, Math.round(colPitch * 0.52)));
        const badgeHeight = Math.max(18, Math.min(
          sectionBottom - badgeTop,
          Math.round(colPitch * 0.33)
        ));
        if (badgeWidth < 26 || badgeHeight < 16 || badgeTop >= sectionBottom) continue;

        const badgeRaw = await sharp(prepared)
          .extract({ left: badgeLeft, top: badgeTop, width: badgeWidth, height: badgeHeight })
          .removeAlpha()
          .png()
          .toBuffer();

        const { data: badgePixels, info: badgeInfo } = await sharp(badgeRaw)
          .removeAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        let darkPixels = 0;
        let yellowPixels = 0;
        const badgePixelCount = Math.max(1, badgeInfo.width * badgeInfo.height);
        for (let i = 0; i < badgePixels.length; i += badgeInfo.channels) {
          const r = badgePixels[i];
          const g = badgePixels[i + 1];
          const b = badgePixels[i + 2];
          if (r < 80 && g < 80 && b < 80) darkPixels++;
          if (r > 160 && g > 125 && b < 135 && r - b > 40) yellowPixels++;
        }
        const badgeMetrics = {
          darkRatio: darkPixels / badgePixelCount,
          yellowRatio: yellowPixels / badgePixelCount
        };

        // A fast visual gate rejects obvious non-rarity areas and empty/noisy
        // crops before invoking Tesseract.
        if (badgeMetrics.darkRatio < 0.18 || badgeMetrics.yellowRatio < 0.0025) continue;

        const badgeVariants = [
          { label: 'badge-normal', psm: '10', bytes: await prepareBadgeVariant(badgeRaw) },
          { label: 'badge-clahe', psm: '10', bytes: await prepareBadgeVariant(badgeRaw, { clahe: true }) },
          { label: 'badge-threshold-125', psm: '10', bytes: await prepareBadgeVariant(badgeRaw, { threshold: 125 }) },
          { label: 'badge-threshold-175', psm: '10', bytes: await prepareBadgeVariant(badgeRaw, { threshold: 175 }) },
          { label: 'badge-inverted-clahe', psm: '10', bytes: await prepareBadgeVariant(badgeRaw, { clahe: true, negate: true }) }
        ].slice(0, clamp(badgePasses, 2, 5));

        const tightLeft = Math.max(0, Math.round(col * colPitch + colPitch * 0.045));
        const tightTop = Math.max(sectionTop, Math.round(sectionTop + colPitch * 0.045 + row * rowPitch));
        const tightWidth = Math.max(48, Math.min(w - tightLeft, Math.round(colPitch * 0.91)));
        const tightHeight = Math.max(24, Math.min(
          sectionBottom - tightTop,
          Math.round(colPitch * 0.19)
        ));
        if (tightWidth < 48 || tightHeight < 18 || tightTop >= sectionBottom) continue;

        const wideLeft = Math.max(0, Math.round(col * colPitch + colPitch * 0.02));
        const wideTop = Math.max(sectionTop, Math.round(sectionTop + colPitch * 0.02 + row * rowPitch));
        const wideWidth = Math.max(48, Math.min(w - wideLeft, Math.round(colPitch * 0.96)));
        const wideHeight = Math.max(24, Math.min(
          sectionBottom - wideTop,
          Math.round(colPitch * 0.25)
        ));
        if (wideWidth < 48 || wideHeight < 18 || wideTop >= sectionBottom) continue;

        const tightRaw = await sharp(prepared)
          .extract({ left: tightLeft, top: tightTop, width: tightWidth, height: tightHeight })
          .png()
          .toBuffer();
        const wideRaw = await sharp(prepared)
          .extract({ left: wideLeft, top: wideTop, width: wideWidth, height: wideHeight })
          .png()
          .toBuffer();

        const stats = await sharp(wideRaw).grayscale().stats();
        const ch = stats.channels?.[0];
        const mean = ch?.mean ?? 190;
        const softThreshold = clamp(Math.round(mean * 0.88), 145, 205);
        const strongThreshold = clamp(softThreshold + 22, 165, 225);

        const variants = [
          {
            label: 'tight-normal',
            psm: '7',
            bytes: await prepareTitleVariant(tightRaw, { width: 1280 })
          },
          {
            label: 'tight-clahe',
            psm: '7',
            bytes: await prepareTitleVariant(tightRaw, { width: 1280, clahe: true })
          },
          {
            label: `tight-threshold-${softThreshold}`,
            psm: '7',
            bytes: await prepareTitleVariant(tightRaw, { width: 1280, threshold: softThreshold })
          },
          {
            label: `wide-threshold-${strongThreshold}`,
            psm: '7',
            bytes: await prepareTitleVariant(wideRaw, { width: 1280, threshold: strongThreshold })
          },
          {
            label: 'wide-raw-line',
            psm: '13',
            bytes: await prepareTitleVariant(wideRaw, { width: 1280, clahe: true, linear: { a: 1.15, b: -12 } })
          },
          {
            label: 'wide-clahe-line',
            psm: '7',
            bytes: await prepareTitleVariant(wideRaw, { width: 1280, clahe: true })
          },
          {
            label: 'tight-raw-line',
            psm: '13',
            bytes: await prepareTitleVariant(tightRaw, { width: 1280, linear: { a: 1.12, b: -8 } })
          }
        ].slice(0, clamp(passesPerCard, 1, 7));

        const visualLeft = Math.max(0, Math.round(col * colPitch + colPitch * 0.055));
        const visualTop = Math.max(sectionTop, Math.round(sectionTop + colPitch * 0.035 + row * rowPitch));
        const visualWidth = Math.max(48, Math.min(w - visualLeft, Math.round(colPitch * 0.89)));
        const visualHeight = Math.max(56, Math.min(sectionBottom - visualTop, Math.round(colPitch * 1.06)));
        const visualBytes = visualTop < sectionBottom && visualHeight >= 40
          ? await sharp(prepared).extract({ left: visualLeft, top: visualTop, width: visualWidth, height: visualHeight }).png().toBuffer()
          : null;

        cells.push({ kind, row, col, variants, badgeVariants, badgeMetrics, visualBytes });
      }
    }
  };

  await addSection('demand', demandTop, demandBottom);
  await addSection('supply', supplyTop, supplyBottom);
  return cells;
}

function likelyTradeImagePost(body = '', urls = []) {
  const clue = String(body || '');
  if (/(ポケポケ|pokemon|tcg|トレードメーカー|trade)/i.test(clue) && /(トレード|交換|求|譲|画像|サポート)/i.test(clue)) return true;
  return urls.some(u => /gamewith|pbs\.twimg\.com|twimg\.com/i.test(u));
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

async function buildOcrCandidates(bytes, {
  maxCandidatePasses = 10,
  upscaleMinWidth = 1800,
  upscaleMaxWidth = 3200
} = {}) {
  const { default: sharp } = await import('sharp');
  const source = sharp(bytes, { failOn: 'none', limitInputPixels: 80_000_000 });
  const meta = await source.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) return [{ label: 'full-original', bytes, psm: '11' }];

  const targetWidth = Math.min(
    upscaleMaxWidth,
    width < upscaleMinWidth ? Math.max(width * 2, upscaleMinWidth) : width
  );

  const resized = await sharp(bytes, { failOn: 'none', limitInputPixels: 80_000_000 })
    .resize({ width: targetWidth, withoutEnlargement: false, fastShrinkOnLoad: false })
    .grayscale()
    .normalize()
    .sharpen({ sigma: 1 })
    .png()
    .toBuffer();

  const clahe = await sharp(resized)
    .clahe({ width: 3, height: 3, maxSlope: 3 })
    .sharpen({ sigma: 0.8 })
    .png()
    .toBuffer();

  const stats = await sharp(resized).stats();
  const mean = stats.channels?.[0]?.mean ?? 180;
  const thresholdA = clamp(Math.round(mean * 0.86), 135, 190);
  const thresholdB = clamp(thresholdA + 35, 170, 220);

  const thresholdSoft = await sharp(resized).threshold(thresholdA).png().toBuffer();
  const thresholdStrong = await sharp(resized).threshold(thresholdB).png().toBuffer();
  const inverted = await sharp(resized).negate().normalize().png().toBuffer();

  const fullMeta = await sharp(resized).metadata();
  const w = fullMeta.width ?? width;
  const h = fullMeta.height ?? height;

  const crop = async (buffer, label, left, top, cw, ch, psm = '6') => {
    const l = Math.max(0, Math.min(w - 1, Math.round(left)));
    const t = Math.max(0, Math.min(h - 1, Math.round(top)));
    const ww = Math.max(120, Math.min(w - l, Math.round(cw)));
    const hh = Math.max(120, Math.min(h - t, Math.round(ch)));
    return {
      label,
      psm,
      bytes: await sharp(buffer)
        .extract({ left: l, top: t, width: ww, height: hh })
        .png()
        .toBuffer()
    };
  };

  const candidates = [
    { label: 'full-prepared', bytes: resized, psm: '11' },
    await crop(resized, 'crop-left', 0, 0, w * 0.58, h, '6'),
    await crop(resized, 'crop-right', w * 0.42, 0, w * 0.58, h, '6'),
    await crop(resized, 'crop-top', 0, 0, w, h * 0.58, '6'),
    await crop(resized, 'crop-bottom', 0, h * 0.42, w, h * 0.58, '6'),
    { label: 'full-clahe', bytes: clahe, psm: '11' },
    { label: `full-threshold-${thresholdA}`, bytes: thresholdSoft, psm: '11' },
    { label: 'full-inverted', bytes: inverted, psm: '11' },
    await crop(clahe, 'crop-center-clahe', w * 0.08, h * 0.18, w * 0.84, h * 0.64, '6'),
    { label: `full-threshold-${thresholdB}`, bytes: thresholdStrong, psm: '11' },
    await crop(clahe, 'crop-top-left', 0, 0, w * 0.56, h * 0.56, '6'),
    await crop(clahe, 'crop-top-right', w * 0.44, 0, w * 0.56, h * 0.56, '6'),
    await crop(clahe, 'crop-bottom-left', 0, h * 0.44, w * 0.56, h * 0.56, '6'),
    await crop(clahe, 'crop-bottom-right', w * 0.44, h * 0.44, w * 0.56, h * 0.56, '6')
  ];

  return candidates.slice(0, Math.max(1, maxCandidatePasses));
}

export async function createTradeImageOcr({
  cards,
  aliases = {},
  cachePath,
  enabled = true,
  maxImagesPerPost = 4,
  maxNewImagesPerRun = 200,
  maxCandidatePasses = 12,
  gameWithPassesPerCard = 7,
  gameWithBadgePasses = 5,
  requireVerifiedStar2 = true,
  processingBudgetMs = 10_800_000,
  imageMatchEnabled = true,
  imageMatchReferenceCachePath = null,
  imageMatchNameMap = {},
  imageMatchRefreshHours = 24,
  imageMatchStrongScore = 0.92,
  imageMatchAgreeScore = 0.80,
  imageMatchMinMargin = 0.035,
  imageMatchStrongMargin = 0.055,
  upscaleMinWidth = 1800,
  upscaleMaxWidth = 3200,
  timeoutMs = 30_000,
  cacheHours = 720,
  cacheVersion = DEFAULT_CACHE_VERSION,
  fetchImpl = fetch,
  log = console.log
}) {
  const cache = await readJson(cachePath, {});
  let worker = null;
  let psmValues = { AUTO: '3', SINGLE_BLOCK: '6', SINGLE_LINE: '7', SPARSE_TEXT: '11', SINGLE_CHAR: '10', RAW_LINE: '13' };
  let dirty = false;

  const cacheCutoff = Date.now() - cacheHours * 3600_000;
  for (const [url, item] of Object.entries(cache)) {
    const checkedAt = item?.checkedAt ? new Date(item.checkedAt).getTime() : 0;
    if (!checkedAt || checkedAt < cacheCutoff || item?.cacheVersion !== cacheVersion) {
      delete cache[url];
      dirty = true;
    }
  }

  let newImages = 0;
  let cacheHits = 0;
  let failedImages = 0;
  let recognizedImages = 0;
  let postsFromImages = 0;
  let candidatePasses = 0;
  let gameWithImages = 0;
  let gameWithCells = 0;
  let gameWithMatchedCells = 0;
  let gameWithStar2VerifiedCells = 0;
  let gameWithRejectedRarityCells = 0;
  let genericRejectedNoStar2 = 0;
  let genericRejectedSale = 0;
  let imageMatcher = null;
  let imageMatcherInitAttempted = false;
  let imageMatchedCells = 0;
  let imageStrongOnlyCells = 0;
  let imageOcrAgreedCells = 0;
  let imageConflictCells = 0;
  let imageUncertainCells = 0;
  let ocrProcessingMs = 0;
  let processingBudgetSkips = 0;

  const freshEnough = item => {
    const t = item?.checkedAt ? new Date(item.checkedAt).getTime() : 0;
    return item?.cacheVersion === cacheVersion && t && Date.now() - t < cacheHours * 3600_000;
  };

  const ensureWorker = async () => {
    if (worker) return worker;
    const tesseract = await import('tesseract.js');
    const { createWorker, PSM } = tesseract;
    if (PSM) {
      psmValues = {
        AUTO: String(PSM.AUTO ?? '3'),
        SINGLE_BLOCK: String(PSM.SINGLE_BLOCK ?? '6'),
        SINGLE_LINE: String(PSM.SINGLE_LINE ?? '7'),
        SPARSE_TEXT: String(PSM.SPARSE_TEXT ?? '11'),
        SINGLE_CHAR: String(PSM.SINGLE_CHAR ?? '10'),
        RAW_LINE: String(PSM.RAW_LINE ?? '13')
      };
    }
    worker = await createWorker(['jpn', 'eng'], 1, {
      logger: m => {
        if (m?.status === 'recognizing text' && Number.isFinite(m.progress)) {
          const pct = Math.round(m.progress * 100);
          if ([25, 50, 75, 100].includes(pct)) log(`[ocr] ${pct}%`);
        }
      }
    });
    await worker.setParameters({
      preserve_interword_spaces: '1',
      user_defined_dpi: '300'
    });
    return worker;
  };

  const ensureImageMatcher = async () => {
    if (!imageMatchEnabled || !imageMatchReferenceCachePath) return null;
    if (imageMatcherInitAttempted) return imageMatcher;
    imageMatcherInitAttempted = true;
    try {
      imageMatcher = await createCardImageMatcher({
        cachePath: imageMatchReferenceCachePath,
        cards,
        nameMap: imageMatchNameMap,
        enabled: imageMatchEnabled,
        refreshHours: imageMatchRefreshHours,
        strongScore: imageMatchStrongScore,
        agreeScore: imageMatchAgreeScore,
        minMargin: imageMatchMinMargin,
        strongMargin: imageMatchStrongMargin,
        fetchImpl,
        log
      });
    } catch (err) {
      log(`[image-match] init failed: ${String(err?.message ?? err)}`);
      imageMatcher = null;
    }
    return imageMatcher;
  };

  const recognizeUrl = async url => {
    const cached = cache[url];
    if (cached && freshEnough(cached)) {
      cacheHits++;
      return cached;
    }
    if (newImages >= maxNewImagesPerRun) {
      return { skipped: 'run-limit', demand: [], supply: [], explicit: false };
    }
    newImages++;
    const processStartedAt = Date.now();
    let detectedGameWith = false;

    try {
      const res = await fetchImpl(url, {
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!res.ok) throw new Error(`image HTTP ${res.status}`);
      const contentType = res.headers?.get?.('content-type') ?? '';
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength > 12_000_000) throw new Error('image too large');
      if (contentType && !contentType.startsWith('image/')) throw new Error(`not image: ${contentType}`);

      const gameWithLayout = await detectGameWithTradeLayout(bytes);
      detectedGameWith = Boolean(gameWithLayout);

      // Layout detection is cheap. Even after the OCR time budget is exhausted,
      // detect GameWith so the caller knows the image is authoritative and does
      // not fall back to conflicting post text.
      if (ocrProcessingMs >= processingBudgetMs) {
        processingBudgetSkips++;
        return {
          skipped: 'processing-budget',
          demand: [],
          supply: [],
          explicit: false,
          layout: gameWithLayout ? 'gamewith-budget-skip' : 'generic-budget-skip'
        };
      }

      const w = await ensureWorker();

      if (gameWithLayout) {
        gameWithImages++;
        const cells = await buildGameWithCardCells(bytes, gameWithLayout, {
          passesPerCard: gameWithPassesPerCard,
          badgePasses: gameWithBadgePasses,
          upscaleMinWidth: Math.max(2600, upscaleMinWidth),
          upscaleMaxWidth: Math.max(4200, upscaleMaxWidth)
        });
        gameWithCells += cells.length;

        const demand = [];
        const supply = [];
        let imagePasses = 0;
        let imageStar2VerifiedCells = 0;
        let imageRejectedRarityCells = 0;

        for (const cell of cells) {
          const badgeResults = [];
          for (const badge of cell.badgeVariants ?? []) {
            candidatePasses++;
            imagePasses++;
            await w.setParameters({
              preserve_interword_spaces: '1',
              user_defined_dpi: '300',
              tessedit_pageseg_mode: psmValues.SINGLE_CHAR,
              tessedit_char_whitelist: '123'
            });
            const { data } = await w.recognize(badge.bytes);
            badgeResults.push({
              text: data?.text ?? '',
              confidence: Number(data?.confidence ?? 0),
              variant: badge.label
            });
          }

          const star2Verified = verifyGameWithStar2Badge(badgeResults, cell.badgeMetrics);
          if (requireVerifiedStar2 && !star2Verified) {
            gameWithRejectedRarityCells++;
            imageRejectedRarityCells++;
            continue;
          }
          if (star2Verified) {
            gameWithStar2VerifiedCells++;
            imageStar2VerifiedCells++;
          }

          const results = [];
          for (const candidate of cell.variants) {
            candidatePasses++;
            imagePasses++;
            const psm = candidate.psm === '13'
              ? psmValues.RAW_LINE
              : candidate.psm === '7'
                ? psmValues.SINGLE_LINE
                : psmValues.SINGLE_BLOCK;

            await w.setParameters({
              preserve_interword_spaces: '1',
              user_defined_dpi: '300',
              tessedit_pageseg_mode: psm,
              tessedit_char_whitelist: ''
            });

            const { data } = await w.recognize(candidate.bytes);
            results.push({
              text: data?.text ?? '',
              confidence: Number(data?.confidence ?? 0),
              variant: candidate.label
            });
          }

          const ocrCard = chooseGameWithCardConsensus(results, cards, aliases);
          let card = null;
          const matcher = await ensureImageMatcher();
          if (matcher?.ready && cell.visualBytes) {
            const visual = await matcher.match(cell.visualBytes, ocrCard);
            card = visual.card ?? null;
            if (visual.reason === 'image+ocr') imageOcrAgreedCells++;
            else if (visual.reason === 'image-strong') imageStrongOnlyCells++;
            else if (visual.reason === 'image-ocr-conflict') imageConflictCells++;
            else imageUncertainCells++;
            if (card) imageMatchedCells++;
          } else {
            // Only when the reference DB is unavailable, retain the strict v9 OCR fallback.
            card = ocrCard;
          }
          if (!card) continue;
          gameWithMatchedCells++;
          (cell.kind === 'demand' ? demand : supply).push(card);
        }

        const explicit = demand.length > 0 || supply.length > 0;
        const item = {
          checkedAt: new Date().toISOString(),
          cacheVersion,
          explicit,
          demand,
          supply,
          candidatePasses: imagePasses,
          layout: 'gamewith-grid-v2-consensus',
          layoutConfidence: gameWithLayout.confidence,
          cellsChecked: cells.length,
          cellsMatched: demand.length + supply.length,
          star2VerifiedCells: imageStar2VerifiedCells,
          rejectedRarityCells: imageRejectedRarityCells,
          passesPerCard: gameWithPassesPerCard,
          badgePasses: gameWithBadgePasses,
          requireVerifiedStar2,
          imageMatchEnabled,
          imageMatcherReady: Boolean(imageMatcher?.ready)
        };
        cache[url] = item;
        dirty = true;
        recognizedImages++;
        return item;
      }

      const candidates = await buildOcrCandidates(bytes, { maxCandidatePasses, upscaleMinWidth, upscaleMaxWidth });
      const recognized = [];

      for (const candidate of candidates) {
        candidatePasses++;
        const psm = candidate.psm === '6' ? psmValues.SINGLE_BLOCK : psmValues.SPARSE_TEXT;
        await w.setParameters({
          preserve_interword_spaces: '1',
          user_defined_dpi: '300',
          tessedit_pageseg_mode: psm,
          tessedit_char_whitelist: ''
        });

        const { data } = await w.recognize(candidate.bytes);
        recognized.push(data?.text ?? '');
      }

      const genericStar2Verified = recognized.some(hasExplicitStar2Marker);
      const genericSaleDetected = recognized.some(hasCardSaleMarker);
      const demandGroups = [];
      const supplyGroups = [];
      let explicit = false;

      if (genericSaleDetected) {
        genericRejectedSale++;
      } else if (!requireVerifiedStar2 || genericStar2Verified) {
        for (const text of recognized) {
          const dual = parseTradeImageText(text, cards, aliases);
          if (dual.explicit && (dual.demand.length || dual.supply.length)) {
            explicit = true;
            demandGroups.push(dual.demand);
            supplyGroups.push(dual.supply);
            continue;
          }

          const single = parseSingleSideTradeText(text, cards, aliases);
          if (single.explicit && (single.demand.length || single.supply.length)) {
            explicit = true;
            if (single.demand.length) demandGroups.push(single.demand);
            if (single.supply.length) supplyGroups.push(single.supply);
          }
        }
      } else {
        genericRejectedNoStar2++;
      }

      const demand = mergeMentionGroups(demandGroups);
      const supply = mergeMentionGroups(supplyGroups);
      const item = {
        checkedAt: new Date().toISOString(),
        cacheVersion,
        explicit,
        demand,
        supply,
        candidatePasses: candidates.length,
        layout: genericSaleDetected ? 'generic-sale-rejected' : 'generic',
        star2Verified: genericStar2Verified,
        saleRejected: genericSaleDetected,
        requireVerifiedStar2
      };
      cache[url] = item;
      dirty = true;
      recognizedImages++;
      return item;
    } catch (err) {
      failedImages++;
      const item = {
        checkedAt: new Date().toISOString(),
        cacheVersion,
        explicit: false,
        demand: [],
        supply: [],
        layout: detectedGameWith ? 'gamewith-error' : 'error',
        error: String(err?.message ?? err)
      };
      cache[url] = item;
      dirty = true;
      return item;
    } finally {
      ocrProcessingMs += Math.max(0, Date.now() - processStartedAt);
    }
  };

  const parseEntryImages = async (entry, body = '') => {
    const urls = extractImageUrlsFromEntry(entry).slice(0, maxImagesPerPost);
    if (!enabled || !urls.length || !likelyTradeImagePost(body, urls)) {
      return {
        demand: [],
        supply: [],
        explicit: false,
        urls: [],
        gameWithDetected: false,
        authoritative: false
      };
    }

    const gameWithDemandGroups = [];
    const gameWithSupplyGroups = [];
    const otherDemandGroups = [];
    const otherSupplyGroups = [];
    let gameWithDetected = false;
    let gameWithExplicit = false;
    let otherExplicit = false;

    for (const url of urls) {
      const result = await recognizeUrl(url);
      const isGameWith = String(result?.layout ?? '').startsWith('gamewith');

      if (isGameWith) {
        gameWithDetected = true;
        if (result.explicit) gameWithExplicit = true;
        if ((result.demand ?? []).length) gameWithDemandGroups.push(result.demand);
        if ((result.supply ?? []).length) gameWithSupplyGroups.push(result.supply);
      } else {
        if (result.explicit) otherExplicit = true;
        if ((result.demand ?? []).length) otherDemandGroups.push(result.demand);
        if ((result.supply ?? []).length) otherSupplyGroups.push(result.supply);
      }
    }

    if (gameWithDetected) {
      const demand = mergeMentionGroups(gameWithDemandGroups);
      const supply = mergeMentionGroups(gameWithSupplyGroups);
      const explicit = gameWithExplicit && (demand.length > 0 || supply.length > 0);
      if (explicit) postsFromImages++;
      return {
        demand,
        supply,
        explicit,
        urls,
        gameWithDetected: true,
        authoritative: true
      };
    }

    const demand = mergeMentionGroups(otherDemandGroups);
    const supply = mergeMentionGroups(otherSupplyGroups);
    const explicit = otherExplicit && (demand.length > 0 || supply.length > 0);
    if (explicit) postsFromImages++;
    return {
      demand,
      supply,
      explicit,
      urls,
      gameWithDetected: false,
      authoritative: false
    };
  };

  const finalize = async () => {
    if (worker) await worker.terminate();
    if (dirty) await writeJson(cachePath, cache);
  };

  const getStats = () => ({
    enabled,
    cacheVersion,
    newImages,
    cacheHits,
    recognizedImages,
    failedImages,
    postsFromImages,
    candidatePasses,
    gameWithImages,
    gameWithCells,
    gameWithMatchedCells,
    gameWithStar2VerifiedCells,
    gameWithRejectedRarityCells,
    gameWithPassesPerCard,
    gameWithBadgePasses,
    requireVerifiedStar2,
    genericRejectedNoStar2,
    genericRejectedSale,
    imageMatchedCells,
    imageStrongOnlyCells,
    imageOcrAgreedCells,
    imageConflictCells,
    imageUncertainCells,
    imageMatcher: imageMatcher?.stats?.() ?? { enabled: imageMatchEnabled, ready: false, references: 0 },
    ocrProcessingMs,
    processingBudgetMs,
    processingBudgetSkips,
    maxNewImagesPerRun,
    maxCandidatePasses
  });

  return { parseEntryImages, finalize, getStats };
}
