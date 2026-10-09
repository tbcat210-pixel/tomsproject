import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRankings } from '../scripts/lib.mjs';

test('only 24-hour, 48-hour and 1-week ranking windows are published', () => {
  const posts = [{ createdAt: '2026-10-10T09:00:00Z', demand: ['ナツメ'], supply: ['カスミ'] }];
  const windows = buildRankings(posts, ['ナツメ', 'カスミ'], new Date('2026-10-10T10:00:00Z'));
  assert.deepEqual(Object.keys(windows), ['24h', '48h', '168h']);
  assert.equal(windows['24h'].rankings.find(x => x.name === 'ナツメ').demand, 1);
});
