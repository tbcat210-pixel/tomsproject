import test from 'node:test';
import assert from 'node:assert/strict';
import { vectorCorrelation, normalizedMae, fingerprintSimilarity, extractStar2SupporterReferences, rankReferenceMatches, decideVisualCard } from '../scripts/card-image-matcher.mjs';

function b64(xs) { return Buffer.from(new Uint8Array(xs)).toString('base64'); }
function fp(grayValue = 100, colorValue = 120) {
  const gray = Array(24 * 24).fill(grayValue);
  for (let i = 0; i < gray.length; i += 17) gray[i] = Math.min(255, grayValue + 60);
  const color = Array(12 * 12 * 3).fill(colorValue);
  for (let i = 0; i < color.length; i += 29) color[i] = Math.min(255, colorValue + 50);
  return { version: 1, gray: b64(gray), color: b64(color) };
}

test('correlation and MAE prefer identical vectors', () => {
  const a = new Uint8Array([0,10,30,80,120,200]);
  const b = new Uint8Array([0,10,30,80,120,200]);
  const c = new Uint8Array([200,120,80,30,10,0]);
  assert.ok(vectorCorrelation(a,b) > 0.99);
  assert.ok(vectorCorrelation(a,c) < 0);
  assert.equal(normalizedMae(a,b), 0);
});

test('fingerprint similarity is highest for identical fingerprint', () => {
  const a = fp(90,110), b = fp(90,110), c = fp(170,200);
  assert.ok(fingerprintSimilarity(a,b) > fingerprintSimilarity(a,c));
});

test('extracts only mapped allowed ☆☆ Supporters', () => {
  const payload = [
    {id:'a-1',name:'Erika',type:'Trainer',subtype:'Supporter',rarity:'☆☆',image_png:'x1'},
    {id:'a-2',name:'Misty',type:'Trainer',subtype:'Supporter',rarity:'☆',image_png:'x2'},
    {id:'a-3',name:'Pikachu',type:'Pokémon',subtype:'Lightning',rarity:'☆☆',image_png:'x3'}
  ];
  const refs = extractStar2SupporterReferences(payload, {Erika:'エリカ'}, ['エリカ']);
  assert.deepEqual(refs.map(x=>x.canonical), ['エリカ']);
});

test('visual decision accepts image+OCR agreement and rejects conflict', () => {
  const best={canonical:'エリカ',score:0.88}, second={canonical:'カスミ',score:0.80};
  assert.equal(decideVisualCard({ocrCard:'エリカ',best,second}).card,'エリカ');
  assert.equal(decideVisualCard({ocrCard:'カスミ',best,second}).card,null);
});

test('strong image match can recover missing OCR', () => {
  const x=decideVisualCard({ocrCard:null,best:{canonical:'エリカ',score:0.96},second:{canonical:'カスミ',score:0.86}});
  assert.equal(x.card,'エリカ');
  assert.equal(x.reason,'image-strong');
});

test('reference ranking groups alternate arts by canonical name', () => {
  const q=fp(90,110);
  const refs=[
    {id:'1',canonical:'エリカ',image:'a',fingerprint:fp(90,110)},
    {id:'2',canonical:'エリカ',image:'b',fingerprint:fp(95,115)},
    {id:'3',canonical:'カスミ',image:'c',fingerprint:fp(180,210)}
  ];
  const ranked=rankReferenceMatches(q,refs);
  assert.equal(ranked.best.canonical,'エリカ');
  assert.equal(ranked.ranked.filter(x=>x.canonical==='エリカ').length,1);
});
