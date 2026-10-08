import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const SOURCE_URL =
  'https://raw.githubusercontent.com/PocketDecks/pokemon-tcg-pocket-cards/refs/heads/main/data/v5/cards.json';

export function extractStar2Supporters(cards = []) {
  const prints = cards.filter(card =>
    card?.type === 'Trainer' &&
    card?.subtype === 'Supporter' &&
    card?.rarity === '☆☆' &&
    typeof card?.name === 'string' &&
    card.name.trim()
  );

  const unique = [];
  const seen = new Set();
  for (const card of prints) {
    const name = card.name.trim();
    if (seen.has(name)) continue;
    seen.add(name);
    unique.push({
      name,
      firstId: card.id ?? null,
      firstSet: card.set_code ?? null
    });
  }
  return { prints, unique };
}

export function auditStar2Supporters({ upstreamCards, configuredCards, nameMap }) {
  const { prints, unique } = extractStar2Supporters(upstreamCards);
  const upstreamNames = unique.map(x => x.name);

  const unknownEnglish = upstreamNames.filter(name => !nameMap[name]);
  const expectedJapanese = upstreamNames
    .map(name => nameMap[name])
    .filter(Boolean);

  const configured = Array.isArray(configuredCards) ? configuredCards : [];
  const configuredSet = new Set(configured);
  const expectedSet = new Set(expectedJapanese);

  const missingJapanese = expectedJapanese.filter(name => !configuredSet.has(name));
  const extraJapanese = configured.filter(name => !expectedSet.has(name));

  const duplicateConfigured = [...new Set(
    configured.filter((name, index) => configured.indexOf(name) !== index)
  )];

  return {
    ok:
      unknownEnglish.length === 0 &&
      missingJapanese.length === 0 &&
      extraJapanese.length === 0 &&
      duplicateConfigured.length === 0,
    printCount: prints.length,
    uniqueCount: unique.length,
    configuredCount: configured.length,
    upstreamNames,
    expectedJapanese,
    unknownEnglish,
    missingJapanese,
    extraJapanese,
    duplicateConfigured
  };
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      'user-agent': 'tomsproject-star2-supporter-audit/1.0',
      'accept': 'application/json'
    },
    signal: AbortSignal.timeout(60_000)
  });
  if (!res.ok) throw new Error(`upstream HTTP ${res.status}`);
  return res.json();
}

function listLine(label, values) {
  return values.length ? `- ${label}: ${values.join(' / ')}` : `- ${label}: なし`;
}

async function main() {
  const [upstreamCards, configRaw, nameMapRaw] = await Promise.all([
    fetchJson(SOURCE_URL),
    fs.readFile(new URL('../config/cards.json', import.meta.url), 'utf8'),
    fs.readFile(new URL('../config/supporter-name-map.json', import.meta.url), 'utf8')
  ]);

  if (!Array.isArray(upstreamCards) || upstreamCards.length < 1000) {
    throw new Error(`upstream sanity check failed: cards=${Array.isArray(upstreamCards) ? upstreamCards.length : 'not-array'}`);
  }

  const config = JSON.parse(configRaw);
  const nameMap = JSON.parse(nameMapRaw);
  const result = auditStar2Supporters({
    upstreamCards,
    configuredCards: config.cards,
    nameMap
  });

  // Guard against an upstream outage or schema break before treating removals
  // as real. The project currently has 82 unique ★2 Supporters.
  if (result.uniqueCount < 75) {
    throw new Error(`upstream supporter sanity check failed: unique=${result.uniqueCount}`);
  }

  const checkedAt = new Date().toISOString();
  const lines = [
    '# ★2サポート 日次監査',
    '',
    `- 確認時刻: ${checkedAt}`,
    `- 上流データ: PocketDecks / pokemon-tcg-pocket-cards v5`,
    `- ★2サポート印刷数: ${result.printCount}`,
    `- ★2サポート種類数（同名重複除外）: ${result.uniqueCount}`,
    `- config/cards.json: ${result.configuredCount}種類`,
    `- 判定: ${result.ok ? '✅ 一致' : '❌ 要確認'}`,
    '',
    listLine('日本語対応表にない新規候補', result.unknownEnglish),
    listLine('config/cards.json に不足', result.missingJapanese),
    listLine('上流に存在しない追加項目', result.extraJapanese),
    listLine('config/cards.json 内の重複', result.duplicateConfigured),
    ''
  ];

  const summary = lines.join('\n');
  console.log(summary);

  if (process.env.GITHUB_STEP_SUMMARY) {
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, summary + '\n', 'utf8');
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}

const isCli = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isCli) {
  main().catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
}
