import { readJson, writeJson } from './lib.mjs';

export const POCKETDECKS_EXPANSIONS_URL =
  'https://raw.githubusercontent.com/PocketDecks/pokemon-tcg-pocket-cards/refs/heads/main/data/v5/expansions.json';

function clamp01(n) {
  return Math.max(0, Math.min(1, Number(n) || 0));
}

function u8ToBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function base64ToU8(value = '') {
  return new Uint8Array(Buffer.from(String(value), 'base64'));
}

function meanStd(values) {
  if (!values.length) return { mean: 0, std: 1 };
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / values.length;
  let sq = 0;
  for (const v of values) {
    const d = v - mean;
    sq += d * d;
  }
  return { mean, std: Math.sqrt(sq / values.length) || 1 };
}

export function vectorCorrelation(aLike, bLike) {
  const a = aLike instanceof Uint8Array ? aLike : new Uint8Array(aLike ?? []);
  const b = bLike instanceof Uint8Array ? bLike : new Uint8Array(bLike ?? []);
  if (!a.length || a.length !== b.length) return -1;
  const as = meanStd(a);
  const bs = meanStd(b);
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += ((a[i] - as.mean) / as.std) * ((b[i] - bs.mean) / bs.std);
  }
  return Math.max(-1, Math.min(1, dot / a.length));
}

export function normalizedMae(aLike, bLike) {
  const a = aLike instanceof Uint8Array ? aLike : new Uint8Array(aLike ?? []);
  const b = bLike instanceof Uint8Array ? bLike : new Uint8Array(bLike ?? []);
  if (!a.length || a.length !== b.length) return 1;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return Math.min(1, sum / a.length / 255);
}

function edgeVector(gray, width, height) {
  const out = new Uint8Array((width - 1) * (height - 1) * 2);
  let k = 0;
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const i = y * width + x;
      out[k++] = Math.min(255, Math.abs(gray[i + 1] - gray[i]) * 3);
      out[k++] = Math.min(255, Math.abs(gray[i + width] - gray[i]) * 3);
    }
  }
  return out;
}

export function fingerprintSimilarity(a, b) {
  if (!a || !b) return 0;
  const ag = base64ToU8(a.gray);
  const bg = base64ToU8(b.gray);
  const ac = base64ToU8(a.color);
  const bc = base64ToU8(b.color);
  if (ag.length !== 24 * 24 || bg.length !== 24 * 24 ||
      ac.length !== 12 * 12 * 3 || bc.length !== 12 * 12 * 3) return 0;
  const grayCorr = (vectorCorrelation(ag, bg) + 1) / 2;
  const edgeCorr = (vectorCorrelation(edgeVector(ag, 24, 24), edgeVector(bg, 24, 24)) + 1) / 2;
  const colorSim = 1 - normalizedMae(ac, bc);
  return clamp01(grayCorr * 0.50 + edgeCorr * 0.32 + colorSim * 0.18);
}

export async function createVisualFingerprint(bytes) {
  const { default: sharp } = await import('sharp');
  const meta = await sharp(bytes, { failOn: 'none', limitInputPixels: 80_000_000 }).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (w < 24 || h < 32) return null;
  const left = Math.max(0, Math.round(w * 0.08));
  const top = Math.max(0, Math.round(h * 0.12));
  const width = Math.max(16, Math.min(w - left, Math.round(w * 0.84)));
  const height = Math.max(20, Math.min(h - top, Math.round(h * 0.62)));
  const crop = sharp(bytes, { failOn: 'none', limitInputPixels: 80_000_000 })
    .extract({ left, top, width, height })
    .removeAlpha();
  const gray = await crop.clone().grayscale().normalize()
    .resize({ width: 24, height: 24, fit: 'fill', kernel: 'lanczos3' })
    .raw().toBuffer();
  const color = await crop.clone()
    .resize({ width: 12, height: 12, fit: 'fill', kernel: 'lanczos3' })
    .raw().toBuffer();
  return { version: 1, gray: u8ToBase64(gray), color: u8ToBase64(color) };
}

export function extractStar2SupporterReferences(expansionCards = [], nameMap = {}, allowedCards = []) {
  const allowed = new Set(allowedCards);
  const out = [];
  for (const card of expansionCards) {
    if (card?.type !== 'Trainer' || card?.subtype !== 'Supporter' || card?.rarity !== '☆☆') continue;
    const canonical = nameMap[card.name];
    if (!canonical || !allowed.has(canonical)) continue;
    const image = card.image_png || card.image;
    if (!image) continue;
    out.push({ id: String(card.id), englishName: card.name, canonical, image: String(image) });
  }
  return out;
}

async function fetchJson(url, fetchImpl) {
  const res = await fetchImpl(url, {
    headers: { 'user-agent': 'tomsproject-card-image-reference/1.0', 'accept': 'application/json' },
    redirect: 'follow', signal: AbortSignal.timeout(60_000)
  });
  if (!res.ok) throw new Error(`reference HTTP ${res.status}: ${url}`);
  return res.json();
}

async function fetchBytes(url, fetchImpl) {
  const res = await fetchImpl(url, {
    headers: { 'user-agent': 'tomsproject-card-image-reference/1.0', 'accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' },
    redirect: 'follow', signal: AbortSignal.timeout(60_000)
  });
  if (!res.ok) throw new Error(`reference image HTTP ${res.status}: ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

export function rankReferenceMatches(fingerprint, references = []) {
  if (!fingerprint || !references.length) return { best: null, second: null, ranked: [] };
  const byCanonical = new Map();
  for (const ref of references) {
    if (!ref?.canonical || !ref?.fingerprint) continue;
    const score = fingerprintSimilarity(fingerprint, ref.fingerprint);
    const prev = byCanonical.get(ref.canonical);
    if (!prev || score > prev.score) {
      byCanonical.set(ref.canonical, { canonical: ref.canonical, score, refId: ref.id, image: ref.image });
    }
  }
  const ranked = [...byCanonical.values()].sort((a, b) => b.score - a.score || a.canonical.localeCompare(b.canonical, 'ja'));
  return { best: ranked[0] ?? null, second: ranked[1] ?? null, ranked };
}

export function decideVisualCard({
  ocrCard = null, best = null, second = null,
  strongScore = 0.92, agreeScore = 0.80, minMargin = 0.035, strongMargin = 0.055
} = {}) {
  if (!best?.canonical) return { card: null, reason: 'no-image-match' };
  const margin = best.score - (second?.score ?? 0);
  if (ocrCard && ocrCard !== best.canonical) {
    return { card: null, reason: 'image-ocr-conflict', imageCard: best.canonical, score: best.score, margin };
  }
  if (!ocrCard && best.score >= strongScore && margin >= strongMargin) {
    return { card: best.canonical, reason: 'image-strong', score: best.score, margin };
  }
  if (ocrCard === best.canonical && best.score >= agreeScore && margin >= minMargin) {
    return { card: best.canonical, reason: 'image+ocr', score: best.score, margin };
  }
  return { card: null, reason: 'image-not-confident', imageCard: best.canonical, score: best.score, margin };
}

export async function createCardImageMatcher({
  cachePath, cards = [], nameMap = {}, enabled = true, refreshHours = 24,
  strongScore = 0.92, agreeScore = 0.80, minMargin = 0.035, strongMargin = 0.055,
  fetchImpl = fetch, log = console.log
} = {}) {
  if (!enabled) {
    return { ready: false, references: [], stats: () => ({ enabled: false, ready: false, references: 0 }), match: async () => ({ card: null, reason: 'disabled' }) };
  }
  let cache = await readJson(cachePath, { version: 1, generatedAt: null, references: [] });
  let references = Array.isArray(cache.references) ? cache.references : [];
  let refreshed = false;
  let refreshError = null;
  let downloaded = 0;
  const generatedMs = cache.generatedAt ? new Date(cache.generatedAt).getTime() : 0;
  const stale = !generatedMs || Date.now() - generatedMs >= refreshHours * 3600_000;

  if (stale || !references.length) {
    try {
      const expansions = await fetchJson(POCKETDECKS_EXPANSIONS_URL, fetchImpl);
      const candidateMap = new Map();
      for (const exp of Array.isArray(expansions) ? expansions : []) {
        if (!exp?.cards_url) continue;
        const payload = await fetchJson(exp.cards_url, fetchImpl);
        for (const ref of extractStar2SupporterReferences(payload, nameMap, cards)) candidateMap.set(`${ref.id}\u0000${ref.image}`, ref);
      }
      const old = new Map(references.map(x => [`${x.id}\u0000${x.image}`, x]));
      const next = [];
      for (const ref of candidateMap.values()) {
        const existing = old.get(`${ref.id}\u0000${ref.image}`);
        if (existing?.fingerprint) { next.push(existing); continue; }
        try {
          const bytes = await fetchBytes(ref.image, fetchImpl);
          const fingerprint = await createVisualFingerprint(bytes);
          if (!fingerprint) continue;
          next.push({ ...ref, fingerprint });
          downloaded++;
        } catch (err) {
          log(`[image-ref] ${ref.id} ${ref.canonical}: ${String(err?.message ?? err)}`);
        }
      }
      if (next.length >= Math.max(20, Math.floor(cards.length * 0.65))) {
        references = next;
        cache = { version: 1, generatedAt: new Date().toISOString(), source: 'PocketDecks/pokemon-tcg-pocket-cards v5', references };
        await writeJson(cachePath, cache);
        refreshed = true;
      } else {
        throw new Error(`too few reference images: ${next.length}`);
      }
    } catch (err) {
      refreshError = String(err?.message ?? err);
      log(`[image-ref] refresh failed; using existing cache if available: ${refreshError}`);
    }
  }

  const ready = references.length > 0;
  const match = async (bytes, ocrCard = null) => {
    if (!ready) return { card: null, reason: 'reference-db-unavailable' };
    const fingerprint = await createVisualFingerprint(bytes);
    if (!fingerprint) return { card: null, reason: 'fingerprint-failed' };
    const { best, second } = rankReferenceMatches(fingerprint, references);
    return { ...decideVisualCard({ ocrCard, best, second, strongScore, agreeScore, minMargin, strongMargin }), best, second };
  };
  const stats = () => ({ enabled, ready, references: references.length, uniqueCards: new Set(references.map(x => x.canonical)).size, refreshed, downloaded, refreshError });
  return { ready, references, match, stats };
}
