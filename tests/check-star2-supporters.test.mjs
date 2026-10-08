import test from 'node:test';
import assert from 'node:assert/strict';
import { extractStar2Supporters, auditStar2Supporters } from '../scripts/check-star2-supporters.mjs';

test('extracts only unique ★2 Supporters', () => {
  const cards = [
    { id: 'x1', name: 'Erika', type: 'Trainer', subtype: 'Supporter', rarity: '☆☆' },
    { id: 'x2', name: 'Erika', type: 'Trainer', subtype: 'Supporter', rarity: '☆☆' },
    { id: 'x3', name: 'Misty', type: 'Trainer', subtype: 'Supporter', rarity: '◊◊' },
    { id: 'x4', name: 'Sabrina', type: 'Trainer', subtype: 'Supporter', rarity: '☆☆' },
    { id: 'x5', name: 'Pikachu', type: 'Pokémon', subtype: 'Lightning', rarity: '☆☆' }
  ];
  const out = extractStar2Supporters(cards);
  assert.equal(out.prints.length, 3);
  assert.deepEqual(out.unique.map(x => x.name), ['Erika', 'Sabrina']);
});

test('audit passes when Japanese config matches upstream unique names', () => {
  const upstreamCards = [
    { id: 'x1', name: 'Erika', type: 'Trainer', subtype: 'Supporter', rarity: '☆☆' },
    { id: 'x2', name: 'Sabrina', type: 'Trainer', subtype: 'Supporter', rarity: '☆☆' }
  ];
  const result = auditStar2Supporters({
    upstreamCards,
    configuredCards: ['エリカ', 'ナツメ'],
    nameMap: { Erika: 'エリカ', Sabrina: 'ナツメ' }
  });
  assert.equal(result.ok, true);
});

test('audit flags a new unmapped upstream supporter', () => {
  const upstreamCards = [
    { id: 'x1', name: 'Erika', type: 'Trainer', subtype: 'Supporter', rarity: '☆☆' },
    { id: 'x2', name: 'New Supporter', type: 'Trainer', subtype: 'Supporter', rarity: '☆☆' }
  ];
  const result = auditStar2Supporters({
    upstreamCards,
    configuredCards: ['エリカ'],
    nameMap: { Erika: 'エリカ' }
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.unknownEnglish, ['New Supporter']);
});

test('audit flags missing and extra Japanese entries', () => {
  const upstreamCards = [
    { id: 'x1', name: 'Erika', type: 'Trainer', subtype: 'Supporter', rarity: '☆☆' },
    { id: 'x2', name: 'Sabrina', type: 'Trainer', subtype: 'Supporter', rarity: '☆☆' }
  ];
  const result = auditStar2Supporters({
    upstreamCards,
    configuredCards: ['エリカ', '余分'],
    nameMap: { Erika: 'エリカ', Sabrina: 'ナツメ' }
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missingJapanese, ['ナツメ']);
  assert.deepEqual(result.extraJapanese, ['余分']);
});
