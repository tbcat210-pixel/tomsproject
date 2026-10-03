import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTradeText, snowflakeToIso, buildRankings } from '../scripts/lib.mjs';
import fs from 'node:fs';

const config = JSON.parse(fs.readFileSync(new URL('../config/cards.json', import.meta.url), 'utf8'));

test('parses explicit 求/譲 with duplicates', () => {
  const p = parseTradeText('#ポケポケトレード 求：モノマネむすめ、モノマネむすめ、博士の研究、アカギ、ナツメ 譲：ハルカ、ミカン、カンナギタウンの長老、マーズ、カイ、カスミ、キョウ', config.cards, config.aliases);
  assert.equal(p.demand.filter(x => x === 'モノマネむすめ').length, 2);
  assert.ok(p.demand.includes('博士の研究'));
  assert.ok(p.supply.includes('カイ'));
});

test('does not count カイ inside カイリュー or ハラ inside ハラバリー', () => {
  const p = parseTradeText('求：メガカイリューex、ハラバリー 譲：ナツメ', config.cards, config.aliases);
  assert.deepEqual(p.demand, []);
  assert.deepEqual(p.supply, ['ナツメ']);
});

test('supports quantity notation and aliases', () => {
  const p = parseTradeText('出: ポケおね×2 求: モノマネ娘2枚', config.cards, config.aliases);
  assert.equal(p.supply.filter(x => x === 'ポケモンセンターのお姉さん').length, 2);
  assert.equal(p.demand.filter(x => x === 'モノマネむすめ').length, 2);
});

test('snowflake conversion returns ISO', () => {
  assert.match(snowflakeToIso('2000000000000000000'), /^202/);
});

test('ranking sorts zero-supply demand first', () => {
  const now = new Date('2026-10-03T00:00:00Z');
  const posts = [
    { createdAt: '2026-10-02T23:00:00Z', demand: ['ナツメ'], supply: [] },
    { createdAt: '2026-10-02T22:00:00Z', demand: ['アカギ'], supply: ['アカギ'] }
  ];
  const r = buildRankings(posts, config.cards, now)['24h'].rankings;
  assert.equal(r[0].name, 'ナツメ');
  assert.equal(r[0].ratioDisplay, '∞');
});
