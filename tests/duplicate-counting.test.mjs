import test from 'node:test';
import assert from 'node:assert/strict';
import { mergePosts } from '../scripts/collector-core.mjs';

test('same X post counts once per different search query', () => {
  const now = new Date('2026-10-03T05:00:00Z');
  const base = {
    id: '123456789',
    url: 'https://x.com/example/status/123456789',
    author: 'example',
    createdAt: '2026-10-03T04:00:00Z',
    demand: ['ナツメ'],
    supply: ['カスミ']
  };

  const posts = mergePosts([], [
    { ...base, query: '#ポケポケトレード' },
    { ...base, query: 'ポケポケ ナツメ (求 希望) (譲 出 提供)' }
  ], now, 192);

  assert.equal(posts.length, 2);
});

test('same X post from the same query is not re-added every scheduled run', () => {
  const now = new Date('2026-10-03T05:00:00Z');
  const base = {
    id: '123456789',
    url: 'https://x.com/example/status/123456789',
    author: 'example',
    createdAt: '2026-10-03T04:00:00Z',
    query: '#ポケポケトレード'
  };

  const posts = mergePosts(
    [{ ...base, demand: ['ナツメ'], supply: [] }],
    [{ ...base, demand: ['ナツメ', 'ナツメ'], supply: [] }],
    now,
    192
  );

  assert.equal(posts.length, 1);
  assert.equal(posts[0].demand.length, 2);
});
