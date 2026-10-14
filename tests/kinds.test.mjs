import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KINDS, RECOMMENDED, ROWS, autoLayout, canPlace, overlaps, inBounds, addBlock, carryOptions, formatDate, findSpace } from '../js/kinds.js';

const noOverlap = (blocks) => blocks.every((a, i) => blocks.every((b, j) => i === j || !overlaps(a, b)));

test('おすすめの項目は、重ならずA4に収まる', () => {
  const l = autoLayout(RECOMMENDED);
  assert.ok(l);
  assert.equal(l.blocks.length, RECOMMENDED.length);
  assert.ok(l.blocks.every(inBounds));
  assert.ok(noOverlap(l.blocks));
});

test('11項目すべて選んでも収まる', () => {
  const l = autoLayout(KINDS.map((k) => k.kind));
  assert.ok(l, '全部入りで null にならない');
  assert.equal(l.blocks.length, 11);
  assert.ok(l.blocks.every(inBounds));
  assert.ok(noOverlap(l.blocks));
});

test('どの組み合わせでも、収まる場合は重ならず、下まで埋まる', () => {
  const all = KINDS.map((k) => k.kind);
  for (let mask = 1; mask < 1 << all.length; mask++) {
    const pick = all.filter((_, i) => mask & (1 << i));
    const l = autoLayout(pick);
    assert.ok(l, `入らない組み合わせ: ${pick}`);
    assert.equal(l.blocks.length, pick.length);
    assert.ok(l.blocks.every(inBounds), `はみ出し: ${pick}`);
    assert.ok(noOverlap(l.blocks), `重なり: ${pick}`);
    assert.equal(Math.max(...l.blocks.map((b) => b.y + b.h)), ROWS, `下に空き: ${pick}`);
  }
});

test('先生の補足は右側に置かれる', () => {
  const l = autoLayout(['date', 'title', 'feeling', 'teacher']);
  const t = l.blocks.find((b) => b.kind === 'teacher');
  assert.equal(t.x, 3);
});

test('重なる位置やはみ出す位置には置けない', () => {
  const l = autoLayout(RECOMMENDED);
  const photo = l.blocks.find((b) => b.kind === 'photo');
  assert.equal(canPlace(l.blocks, { ...photo, y: 0 }), false);
  assert.equal(canPlace(l.blocks, { ...photo, x: 4 }), false);
  assert.equal(canPlace(l.blocks, { ...photo }), true);
});

test('欄を足すときは空いている場所をさがし、なければ null', () => {
  const l = { blocks: [{ id: 'a', kind: 'free', x: 0, y: 0, w: 6, h: 11 }] };
  const n = addBlock(l, 'teacher');
  assert.ok(n);
  const t = n.blocks.find((b) => b.kind === 'teacher');
  assert.equal(t.y, 11);
  assert.equal(findSpace([{ id: 'a', x: 0, y: 0, w: 6, h: 12 }], 1, 1), null);
});

test('前回の「次回に向けて」と「今日の目標」を引き継ぎ候補にする', () => {
  const l = autoLayout(RECOMMENDED);
  const opts = carryOptions(l, { goal: { text: '葉を数える' }, next: { text: '花を見る' } });
  assert.deepEqual(opts.map((o) => o.text), ['花を見る', '葉を数える']);
  assert.deepEqual(carryOptions(autoLayout(['photo']), { goal: { text: 'x' } }), []);
  assert.deepEqual(carryOptions(l, undefined), []);
});

test('日付の表示', () => {
  assert.equal(formatDate('2026-10-14'), '10月14日（水）');
});
