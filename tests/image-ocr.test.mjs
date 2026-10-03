import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractImageUrlsFromEntry, mergeMentionCounts, mergeMentionGroups, parseTradeImageText, parseSingleSideTradeText } from '../scripts/image-ocr.mjs';

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
