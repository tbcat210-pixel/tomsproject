import { readJson, writeJson, extractCardMentions, cleanText } from './lib.mjs';

const IMAGE_KEY_RE = /(image|img|photo|media|thumbnail|picture|large|orig)/i;
const IMAGE_URL_RE = /\.(?:jpe?g|png|webp)(?:[?#].*)?$/i;
const IMAGE_HOST_RE = /(?:pbs\.twimg\.com|twimg\.com|img\.gamewith\.jp|yimg\.jp)/i;
const DEFAULT_CACHE_VERSION = 4;

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
        candidatePasses: candidates.length
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
    maxNewImagesPerRun,
    maxCandidatePasses
  });

  return { parseEntryImages, finalize, getStats };
}
