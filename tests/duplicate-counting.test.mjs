import test from 'node:test';
import assert from 'node:assert/strict';
import { mergePosts } from '../scripts/collector-core.mjs';

test('same X post collected again is counted again', () => {
  const now = new Date('2026-10-03T06:30:00Z');
  const post = {
    id: '123456789',
    createdAt: '2026-10-03T06:00:00Z',
    query: '#ポケポケトレード',
    demand: ['ナツメ'],
    supply: ['カスミ']
  };

  const posts = mergePosts([post], [post], now, 192);
  assert.equal(posts.length, 2);
});
