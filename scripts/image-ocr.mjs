import { readJson, writeJson, extractCardMentions, cleanText } from './lib.mjs';

const IMAGE_KEY_RE = /(image|img|photo|media|thumbnail|picture|large|orig)/i;
const IMAGE_URL_RE = /\.(?:jpe?g|png|webp)(?:[?#].*)?$/i;
const IMAGE_HOST_RE = /(?:pbs\.twimg\.com|twimg\.com|img\.gamewith\.jp|yimg\.jp)/i;
const DEFAULT_CACHE_VERSION = 5;

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

function minSubstringDistance(text, target) {
  if (!text || !target) return Infinity;
  if (text.includes(target)) return 0;
  const chars = [...text];
  const targetLen = [...target].length;
  let best = Infinity;
  const minLen = Math.max(1, targetLen - 1);
  const maxLen = Math.min(chars.length, targetLen + 1);
  for (let len = minLen; len <= maxLen; len++) {
    for (let i = 0; i + len <= chars.length; i++) {
      const d = levenshteinDistance(chars.slice(i, i + len).join(''), target);
      if (d < best) best = d;
      if (best === 0) return 0;
    }
  }
  return best;
}

export function extractGameWithCardMentions(rawText, cards, aliases = {}) {
  const normalized = normalizeOcrTradeText(rawText);
  if (!normalized) return [];

  // Exact matches are always preferred. The regular matcher already blocks
  // short supporter names from matching inside longer Japanese card names.
  const exact = extractCardMentions(normalized, cards, aliases);
  const out = [...exact];
  const already = new Set(exact);

  const variants = [];
  for (const name of cards) variants.push([name, name]);
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (cards.includes(canonical)) variants.push([alias, canonical]);
  }

  // The GameWith title sheet places one card crop per line. Do fuzzy
  // correction line-by-line and accept at most one canonical card per line.
  // This prevents a noisy OCR blob from spuriously matching many supporters.
  const lines = String(rawText)
    .split(/\r?\n/)
    .map(x => normalizeCardTitleText(x))
    .filter(x => [...x].length >= 3);

  for (const line of lines) {
    const matches = [];
    for (const [variantRaw, canonical] of variants) {
      if (already.has(canonical)) continue;
      const variant = normalizeCardTitleText(variantRaw);
      const length = [...variant].length;

      // Very short names are easy to confuse with Pokémon names and remain
      // exact-only.
      if (length < 4) continue;

      const distance = minSubstringDistance(line, variant);
      const allowed = length >= 8 ? 2 : 1;
      if (distance > allowed) continue;
      const score = 1 - distance / Math.max(1, length);
      if (score < 0.82) continue;
      matches.push({ canonical, distance, score, length });
    }

    matches.sort((a, b) =>
      a.distance - b.distance ||
      b.score - a.score ||
      b.length - a.length ||
      a.canonical.localeCompare(b.canonical, 'ja')
    );
    const best = matches[0];
    const second = matches[1];
    if (!best) continue;

    // If two different cards are essentially tied, do not guess.
    const ambiguous = second &&
      second.canonical !== best.canonical &&
      second.distance === best.distance &&
      Math.abs(second.score - best.score) < 0.06;
    if (ambiguous) continue;

    out.push(best.canonical);
    already.add(best.canonical);
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

      // GameWith maker header bands span nearly the whole width.
      // Pink ranges from coral-pink to magenta.
      if (r >= 175 && r - g >= 25 && b >= 65 && ((r + b) / 2 - g) >= 18) pink++;
      // Blue ranges from cyan to bright blue.
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

  // X's image viewer screenshots can contain a large black letterbox below
  // the maker image. Direct pbs/Yahoo images normally do not, but detecting
  // the boundary makes the layout parser robust in either case.
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

export async function buildGameWithTitleSheets(bytes, layout, {
  maxCandidatePasses = 8,
  upscaleMinWidth = 1800,
  upscaleMaxWidth = 3200
} = {}) {
  const { default: sharp } = await import('sharp');
  const source = sharp(bytes, { failOn: 'none', limitInputPixels: 80_000_000 });
  const meta = await source.metadata();
  const sourceWidth = meta.width ?? 0;
  const sourceHeight = meta.height ?? 0;
  if (!sourceWidth || !sourceHeight) return [];

  const targetWidth = Math.min(
    upscaleMaxWidth,
    sourceWidth < upscaleMinWidth ? Math.max(sourceWidth * 2, upscaleMinWidth) : sourceWidth
  );

  const prepared = await sharp(bytes, { failOn: 'none', limitInputPixels: 80_000_000 })
    .resize({ width: targetWidth, withoutEnlargement: false, fastShrinkOnLoad: false })
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
  const inferRows = (top, bottom) => {
    const sectionHeight = Math.max(0, bottom - top);
    return clamp(Math.round(sectionHeight / rowPitch), 1, 6);
  };

  const buildSheet = async (kind, sectionTop, sectionBottom, rows) => {
    const cellWidth = 720;
    const cellHeight = 118;
    const gap = 20;
    const sheetWidth = cellWidth + 40;
    const cells = [];

    for (let row = 0; row < rows; row++) {
      const titleY = Math.round(sectionTop + colPitch * 0.08 + row * rowPitch);
      const titleHeight = Math.max(22, Math.round(colPitch * 0.16));
      if (titleY + titleHeight > sectionBottom + 2) continue;

      for (let col = 0; col < 8; col++) {
        const left = Math.max(0, Math.round(col * colPitch + colPitch * 0.08));
        const width = Math.max(40, Math.min(
          w - left,
          Math.round(colPitch * 0.84)
        ));
        if (left + width > w || width < 40) continue;

        const rawCell = await sharp(prepared)
          .extract({ left, top: titleY, width, height: titleHeight })
          .grayscale()
          .png()
          .toBuffer();

        const stats = await sharp(rawCell).stats();
        const channel = stats.channels?.[0];
        // Empty maker slots are almost flat pale backgrounds. Skip them
        // before normalization, which would otherwise amplify tiny JPEG noise.
        if ((stats.entropy ?? 0) < 2.2 || (channel?.stdev ?? 0) < 10) continue;

        const cell = await sharp(rawCell)
          .normalize()
          .sharpen({ sigma: 0.7 })
          .resize({ width: cellWidth, height: cellHeight, fit: 'fill', kernel: 'lanczos3' })
          .extend({ top: 4, bottom: 4, left: 4, right: 4, background: '#ffffff' })
          .png()
          .toBuffer();

        cells.push(cell);
      }
    }

    if (!cells.length) return [];
    const sheetHeight = cells.length * (cellHeight + gap) + 20;
    const composites = cells.map((cell, index) => ({
      input: cell,
      left: 16,
      top: 10 + index * (cellHeight + gap)
    }));
    const normal = await sharp({
      create: {
        width: sheetWidth,
        height: sheetHeight,
        channels: 3,
        background: { r: 255, g: 255, b: 255 }
      }
    })
      .composite(composites)
      .png()
      .toBuffer();

    // A second binary view often helps with tiny black title text on bright
    // card headers. Both represent the same cells, so their results are
    // merged by max-count instead of being added twice.
    const binary = await sharp(normal)
      .normalize()
      .threshold(178)
      .png()
      .toBuffer();

    return [
      { label: `gamewith-${kind}-titles-normal`, kind, psm: '6', bytes: normal },
      { label: `gamewith-${kind}-titles-binary`, kind, psm: '6', bytes: binary }
    ];
  };

  const demandRows = inferRows(demandTop, demandBottom);
  const supplyRows = inferRows(supplyTop, supplyBottom);
  const candidates = [
    ...await buildSheet('demand', demandTop, demandBottom, demandRows),
    ...await buildSheet('supply', supplyTop, supplyBottom, supplyRows)
  ];
  return candidates.slice(0, Math.max(1, maxCandidatePasses));
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
  maxCandidatePasses = 10,
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
  let psmValues = { AUTO: '3', SINGLE_BLOCK: '6', SPARSE_TEXT: '11' };
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
        SPARSE_TEXT: String(PSM.SPARSE_TEXT ?? '11')
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

  const recognizeUrl = async url => {
    const cached = cache[url];
    if (cached && freshEnough(cached)) {
      cacheHits++;
      return cached;
    }
    if (newImages >= maxNewImagesPerRun) return { skipped: 'run-limit', demand: [], supply: [], explicit: false };
    newImages++;

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

      const w = await ensureWorker();
      const gameWithLayout = await detectGameWithTradeLayout(bytes);

      if (gameWithLayout) {
        gameWithImages++;
        const candidates = await buildGameWithTitleSheets(bytes, gameWithLayout, {
          maxCandidatePasses,
          upscaleMinWidth,
          upscaleMaxWidth
        });
        const demandGroups = [];
        const supplyGroups = [];

        for (const candidate of candidates) {
          candidatePasses++;
          const psm = candidate.psm === '6' ? psmValues.SINGLE_BLOCK : psmValues.SPARSE_TEXT;
          await w.setParameters({
            preserve_interword_spaces: '1',
            user_defined_dpi: '300',
            tessedit_pageseg_mode: psm
          });

          const { data } = await w.recognize(candidate.bytes);
          const mentions = extractGameWithCardMentions(data?.text ?? '', cards, aliases);
          (candidate.kind === 'demand' ? demandGroups : supplyGroups).push(mentions);
        }

        const demand = mergeMentionGroups(demandGroups);
        const supply = mergeMentionGroups(supplyGroups);
        const explicit = demand.length > 0 || supply.length > 0;
        const item = {
          checkedAt: new Date().toISOString(),
          cacheVersion,
          explicit,
          demand,
          supply,
          candidatePasses: candidates.length,
          layout: 'gamewith-grid-v1',
          layoutConfidence: gameWithLayout.confidence
        };
        cache[url] = item;
        dirty = true;
        recognizedImages++;
        return item;
      }

      const candidates = await buildOcrCandidates(bytes, { maxCandidatePasses, upscaleMinWidth, upscaleMaxWidth });
      const demandGroups = [];
      const supplyGroups = [];
      let explicit = false;

      for (const candidate of candidates) {
        candidatePasses++;
        const psm = candidate.psm === '6' ? psmValues.SINGLE_BLOCK : psmValues.SPARSE_TEXT;
        await w.setParameters({
          preserve_interword_spaces: '1',
          user_defined_dpi: '300',
          tessedit_pageseg_mode: psm
        });

        const { data } = await w.recognize(candidate.bytes);
        const text = data?.text ?? '';

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

      const demand = mergeMentionGroups(demandGroups);
      const supply = mergeMentionGroups(supplyGroups);
      const item = {
        checkedAt: new Date().toISOString(),
        cacheVersion,
        explicit,
        demand,
        supply,
        candidatePasses: candidates.length,
        layout: 'generic'
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
        error: String(err?.message ?? err)
      };
      cache[url] = item;
      dirty = true;
      return item;
    }
  };

  const parseEntryImages = async (entry, body = '') => {
    const urls = extractImageUrlsFromEntry(entry).slice(0, maxImagesPerPost);
    if (!enabled || !urls.length || !likelyTradeImagePost(body, urls)) {
      return { demand: [], supply: [], explicit: false, urls: [] };
    }

    const demandGroups = [];
    const supplyGroups = [];
    let explicit = false;
    for (const url of urls) {
      const result = await recognizeUrl(url);
      if (result.explicit) explicit = true;
      if ((result.demand ?? []).length) demandGroups.push(result.demand);
      if ((result.supply ?? []).length) supplyGroups.push(result.supply);
    }

    const demand = mergeMentionGroups(demandGroups);
    const supply = mergeMentionGroups(supplyGroups);
    if (explicit && (demand.length || supply.length)) postsFromImages++;
    return { demand, supply, explicit, urls };
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
    maxNewImagesPerRun,
    maxCandidatePasses
  });

  return { parseEntryImages, finalize, getStats };
}
