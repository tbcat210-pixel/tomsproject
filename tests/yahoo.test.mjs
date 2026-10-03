import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createdAtFromEntry, makeCardBackfillQueries, parseYahooTimelineEntry, parseYahooTimelineResponse, stripYahooHighlight } from '../scripts/yahoo.mjs';

const config = JSON.parse(fs.readFileSync(new URL('../config/cards.json', import.meta.url), 'utf8'));

test('removes Yahoo highlight markers', () => {
  assert.equal(stripYahooHighlight('求: \tSTART\tナツメ\tEND\t 譲: カスミ'), '求: ナツメ 譲: カスミ');
});

test('parses timeline entry into demand/supply', () => {
  const entry = {
    id: '2000000000000000000',
    url: 'https://x.com/example/status/2000000000000000000',
    screenName: 'example',
    createdAt: 1790980000,
    displayTextBody: '#ポケポケトレード 求: モノマネ娘2枚 譲: ポケおね×2'
  };
  const p = parseYahooTimelineEntry(entry, 'test', config.cards, config.aliases);
  assert.equal(p.demand.filter(x => x === 'モノマネむすめ').length, 2);
  assert.equal(p.supply.filter(x => x === 'ポケモンセンターのお姉さん').length, 2);
});

test('timeline response uses head cursor', () => {
  const data = { timeline: { head: { oldestTweetId: '123' }, entry: [] } };
  assert.equal(parseYahooTimelineResponse(data, 'x', config.cards, config.aliases).nextCursor, '123');
});

test('createdAt accepts Unix seconds', () => {
  assert.equal(createdAtFromEntry({ createdAt: 1760000000 }), new Date(1760000000 * 1000).toISOString());
});

test('history queries include every canonical card and aliases', () => {
  const q = makeCardBackfillQueries(config.cards, config.aliases);
  assert.ok(q.some(x => x.canonical === 'モノマネむすめ' && x.searchName === 'モノマネ娘'));
  assert.ok(config.cards.every(card => q.some(x => x.canonical === card && x.searchName === card)));
});

import { collectYahooQuery } from '../scripts/yahoo.mjs';

test('collectYahooQuery paginates backward until cutoff', async () => {
  const calls = [];
  const page1 = {
    timeline: {
      head: { oldestTweetId: '1900000000000000000' },
      entry: [{
        id: '2000000000000000000', url: 'https://x.com/a/status/2000000000000000000', screenName: 'a',
        createdAt: 1790980000, displayTextBody: '求: ナツメ 譲: カスミ'
      }]
    }
  };
  const page2 = {
    timeline: {
      head: { oldestTweetId: '1800000000000000000' },
      entry: [{
        id: '1900000000000000000', url: 'https://x.com/b/status/1900000000000000000', screenName: 'b',
        createdAt: 1790000000, displayTextBody: '求: アカギ 譲: カスミ'
      }]
    }
  };
  const fetchImpl = async url => {
    calls.push(String(url));
    const data = calls.length === 1 ? page1 : page2;
    return { ok: true, json: async () => data };
  };
  const result = await collectYahooQuery({
    query: 'test', cards: config.cards, aliases: config.aliases,
    since: new Date(1790500000 * 1000), maxPages: 5, throttleMs: 0, retryCount: 0, fetchImpl
  });
  assert.equal(calls.length, 2);
  assert.equal(result.posts.length, 2);
  assert.equal(result.stats.reachedCutoff, true);
  assert.match(calls[1], /oldestTweetId=1900000000000000000/);
});
