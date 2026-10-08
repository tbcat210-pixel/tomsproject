import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  chooseGameWithCardConsensus,
  estimateGameWithRowCount,
  hasCardSaleMarker,
  hasExplicitStar2Marker,
  verifyGameWithStar2Badge,
  extractImageUrlsFromEntry,
  mergeMentionCounts,
  mergeMentionGroups,
  parseTradeImageText,
  parseSingleSideTradeText
} from '../scripts/image-ocr.mjs';

const config = JSON.parse(fs.readFileSync(new URL('../config/cards.json', import.meta.url), 'utf8'));

test('extracts nested image URLs from Yahoo-like entry data', () => {
  const entry = {
    id: '1',
    media: [{ imageUrl: 'https://pbs.twimg.com/media/ABC123?format=jpg&name=small' }],
    other: { thumbnail: 'https://example.com/a.png' }
  };
  const urls = extractImageUrlsFromEntry(entry);
  assert.equal(urls.length, 2);
  assert.ok(urls.some(x => x.includes('pbs.twimg.com/media/ABC123')));
});

test('parses GameWith-style image headings', () => {
  const p = parseTradeImageText(`欲しいカード
モノマネむすめ
博士の研究

出せるカード
ハルカ
カイ`, config.cards, config.aliases);
  assert.deepEqual(p.demand.sort(), ['モノマネむすめ', '博士の研究'].sort());
  assert.deepEqual(p.supply.sort(), ['ハルカ', 'カイ'].sort());
});

test('supports short 求/譲 headings from OCR', () => {
  const p = parseTradeImageText(`求
ナツメ
アカギ
譲
カスミ`, config.cards, config.aliases);
  assert.ok(p.demand.includes('ナツメ'));
  assert.ok(p.demand.includes('アカギ'));
  assert.ok(p.supply.includes('カスミ'));
});

test('supports one-sided cropped OCR text', () => {
  const p = parseSingleSideTradeText(`欲しいカード
ナツメ
アカギ`, config.cards, config.aliases);
  assert.equal(p.kind, 'demand');
  assert.ok(p.demand.includes('ナツメ'));
  assert.ok(p.demand.includes('アカギ'));
  assert.deepEqual(p.supply, []);
});

test('merges text and image without double counting the same trade', () => {
  assert.deepEqual(mergeMentionCounts(['ナツメ'], ['ナツメ', 'ナツメ']).sort(), ['ナツメ', 'ナツメ']);
  assert.deepEqual(mergeMentionCounts(['アカギ'], ['ナツメ']).sort(), ['アカギ', 'ナツメ'].sort());
});

test('merges multiple OCR crop passes by max count', () => {
  const out = mergeMentionGroups([
    ['ナツメ'],
    ['ナツメ', 'ナツメ'],
    ['アカギ']
  ]).sort();
  assert.deepEqual(out, ['アカギ', 'ナツメ', 'ナツメ'].sort());
});

test('GameWith short card names require three exact OCR votes', () => {
  assert.equal(
    chooseGameWithCardConsensus([{ text: 'カイ', confidence: 95 }], config.cards, config.aliases),
    null
  );
  assert.equal(
    chooseGameWithCardConsensus([
      { text: 'カイ', confidence: 90 },
      { text: 'カイ', confidence: 75 }
    ], config.cards, config.aliases),
    null
  );
  assert.equal(
    chooseGameWithCardConsensus([
      { text: 'カイ', confidence: 90 },
      { text: 'カイ', confidence: 82 },
      { text: 'カイ', confidence: 75 }
    ], config.cards, config.aliases),
    'カイ'
  );
  assert.equal(
    chooseGameWithCardConsensus([
      { text: 'カイリュー', confidence: 95 },
      { text: 'カイリュー', confidence: 90 },
      { text: 'カイリュー', confidence: 85 }
    ], config.cards, config.aliases),
    null
  );
});

test('GameWith short fuzzy OCR is rejected even when repeated', () => {
  assert.equal(
    chooseGameWithCardConsensus([
      { text: 'カミツル', confidence: 80 },
      { text: 'カミツル', confidence: 72 },
      { text: 'カミツル', confidence: 65 }
    ], config.cards, config.aliases),
    null
  );
});

test('GameWith long fuzzy OCR needs at least three agreeing passes', () => {
  const noisy = 'ロケット団のしたつぱ';
  assert.equal(
    chooseGameWithCardConsensus([{ text: noisy, confidence: 82 }], config.cards, config.aliases),
    null
  );
  assert.equal(
    chooseGameWithCardConsensus([
      { text: noisy, confidence: 82 },
      { text: noisy, confidence: 76 },
      { text: noisy, confidence: 70 }
    ], config.cards, config.aliases),
    'ロケット団のしたっぱ'
  );
});

test('GameWith conflicting exact OCR results are rejected', () => {
  assert.equal(
    chooseGameWithCardConsensus([
      { text: 'カイ', confidence: 90 },
      { text: 'カイ', confidence: 80 },
      { text: 'マオ', confidence: 90 },
      { text: 'マオ', confidence: 80 }
    ], config.cards, config.aliases),
    null
  );
});


test('detects explicit ★2 markers in generic OCR text', () => {
  assert.equal(hasExplicitStar2Marker('交換画像 ★2 サポート'), true);
  assert.equal(hasExplicitStar2Marker('交換画像 ☆2 サポート'), true);
  assert.equal(hasExplicitStar2Marker('交換画像 ☆☆ サポート'), true);
  assert.equal(hasExplicitStar2Marker('2 stars Supporter'), true);
  assert.equal(hasExplicitStar2Marker('★1 サポート'), false);
});

test('GameWith ★2 badge requires visual badge evidence and two OCR votes', () => {
  const metrics = { darkRatio: 0.31, yellowRatio: 0.02 };
  assert.equal(
    verifyGameWithStar2Badge(
      [{ text: '12' }, { text: '2' }, { text: '2' }],
      metrics
    ),
    true
  );
  assert.equal(
    verifyGameWithStar2Badge(
      [{ text: '2' }, { text: '' }, { text: '' }],
      metrics
    ),
    false
  );
  assert.equal(
    verifyGameWithStar2Badge(
      [{ text: '11' }, { text: '1' }, { text: '1' }],
      metrics
    ),
    false
  );
  assert.equal(
    verifyGameWithStar2Badge(
      [{ text: '12' }, { text: '2' }, { text: '2' }],
      { darkRatio: 0.05, yellowRatio: 0.001 }
    ),
    false
  );
});


test('v8 ordinary names require two exact votes', () => {
  assert.equal(
    chooseGameWithCardConsensus([{ text: 'カミツレ', confidence: 96 }], config.cards, config.aliases),
    null
  );
  assert.equal(
    chooseGameWithCardConsensus([
      { text: 'カミツレ', confidence: 96 },
      { text: 'カミツレ', confidence: 94 }
    ], config.cards, config.aliases),
    'カミツレ'
  );
});

test('v8 five-pass rarity badge needs a clear ★2 majority', () => {
  const metrics = { darkRatio: 0.5, yellowRatio: 0.02 };
  assert.equal(verifyGameWithStar2Badge(
    [{ text:'2' }, { text:'2' }, { text:'2' }, { text:'1' }, { text:'' }],
    metrics
  ), true);
  assert.equal(verifyGameWithStar2Badge(
    [{ text:'2' }, { text:'2' }, { text:'1' }, { text:'3' }, { text:'' }],
    metrics
  ), false);
});


test('dense GameWith sections can scan more than six rows', () => {
  const colPitch = 100;
  const rowPitch = 136;
  // Enough space for 8 real rows; old logic was capped at 6.
  const sectionHeight = 100 * 1.02 + 7 * rowPitch + 30;
  assert.equal(estimateGameWithRowCount(sectionHeight, colPitch, rowPitch), 8);
});

test('GameWith row estimator matches dense maker geometry', () => {
  const colPitch = 88.625;
  const rowPitch = colPitch * 1.36;
  assert.equal(estimateGameWithRowCount(254, colPitch, rowPitch), 2);
  assert.equal(estimateGameWithRowCount(513, colPitch, rowPitch), 4);
});

test('generic OCR sale markers are rejected', () => {
  assert.equal(hasCardSaleMarker('ポケポケ ★2 販売 1500円'), true);
  assert.equal(hasCardSaleMarker('買取表 PayPay対応'), true);
  assert.equal(hasCardSaleMarker('販売不可・金銭取引なし、交換のみ'), false);
  assert.equal(hasCardSaleMarker('求 ナツメ 譲 カスミ'), false);
});
