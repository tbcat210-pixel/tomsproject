import test from 'node:test';
import assert from 'node:assert/strict';
import { pagesForQuery, requestsWithin24Hours } from '../scripts/request-budget.mjs';
import { collectYahooQuery } from '../scripts/yahoo.mjs';

const budget = (remainingRun, remainingDay, queriesLeft, maxPagesPerQuery = 10) =>
  pagesForQuery({ remainingRun, remainingDay, queriesLeft, maxPagesPerQuery });

test('four-hour run keeps eight search phrases and never exceeds 12 requests', () => {
  let spent = 0;
  const allocated = [];
  for (let i = 0; i < 8; i++) {
    const n = budget(12 - spent, 72 - spent, 8 - i);
    allocated.push(n);
    spent += n;
  }
  assert.deepEqual(allocated, [5, 1, 1, 1, 1, 1, 1, 1]);
  assert.equal(spent, 12);
});

test('exhausted rolling daily quota skips fetches instead of exceeding it', () => {
  assert.equal(budget(12, 0, 8), 0);
  assert.equal(budget(12, 3, 8), 1);
  assert.equal(budget(10, 9, 8), 2);
});

test('rolling request timestamps exclude entries over 24h old', () => {
  const now = new Date('2026-10-10T10:00:00Z');
  assert.deepEqual(requestsWithin24Hours([
    '2026-10-09T09:59:59Z',
    '2026-10-09T10:00:01Z',
    '2026-10-10T09:59:59Z',
    '2026-10-10T10:01:00Z',
    'bad time'
  ], now), ['2026-10-09T10:00:01Z', '2026-10-10T09:59:59Z']);
});

test('cached accepted post saves OCR calls but preserves collected counts', async () => {
  const existing = {
    id: '2000000000000000000',
    createdAt: '2026-10-09T06:00:00.000Z',
    demand: ['ナツメ', 'ナツメ'],
    supply: ['カスミ']
  };
  const cache = new Map([[existing.id, existing]]);
  let imageCalls = 0;
  let pageCalls = 0;
  const data = { timeline: { entry: [{
    id: existing.id,
    createdAt: 1791525600,
    displayTextBody: '求: ナツメ 譲: カスミ',
    url: 'https://x.com/a/status/' + existing.id
  }] } };
  const result = await collectYahooQuery({
    query: '#ポケポケトレード',
    cards: ['ナツメ', 'カスミ'],
    maxPages: 1,
    throttleMs: 0,
    imageOcr: { parseEntryImages: async () => { imageCalls++; throw Error('No OCR expected'); } },
    cachedPostsById: cache,
    onRequest: () => pageCalls++,
    fetchImpl: async () => ({ ok: true, json: async () => data })
  });
  assert.equal(pageCalls, 1);
  assert.equal(imageCalls, 0);
  assert.deepEqual(result.posts[0].demand, ['ナツメ', 'ナツメ']);
  assert.deepEqual(result.posts[0].supply, ['カスミ']);
});
