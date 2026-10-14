import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KINDS, RECOMMENDED, ROWS, autoLayout, canPlace, overlaps, inBounds, addBlock, carryOptions, formatDate, findSpace, goalText, countsText, newCountRow } from '../js/kinds.js';

const noOverlap = (blocks) => blocks.every((a, i) => blocks.every((b, j) => i === j || !overlaps(a, b)));

test('おすすめの項目は、重ならずA4に収まる', () => {
  const l = autoLayout(RECOMMENDED);
  assert.ok(l);
  assert.equal(l.blocks.length, RECOMMENDED.length);
  assert.ok(l.blocks.every(inBounds));
  assert.ok(noOverlap(l.blocks));
});

test('すべての項目を選んでも収まる', () => {
  const l = autoLayout(KINDS.map((k) => k.kind));
  assert.ok(l, '全部入りで null にならない');
  assert.equal(l.blocks.length, KINDS.length);
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

test('目標の欄は、はじめは「文字」で単位は「回」', () => {
  const g = autoLayout(RECOMMENDED).blocks.find((b) => b.kind === 'goal');
  assert.equal(g.goalMode, 'text');
  assert.equal(g.unit, '回');
  assert.equal(g.showResult, false);
});

test('目標の表示：書き方に合わせて文字・数字・できた数を出す', () => {
  const v = { text: 'なわとび', num: 10, result: 8 };
  assert.equal(goalText({ goalMode: 'text', unit: '回' }, v), 'なわとび');
  assert.equal(goalText({ goalMode: 'number', unit: '回' }, v), '目標 10回');
  assert.equal(goalText({ goalMode: 'both', unit: '回', showResult: true }, v), 'なわとび　目標 10回　できた 8回');
  assert.equal(goalText({ goalMode: 'both', unit: '回' }, { text: '', num: '' }), '');
  assert.equal(goalText({ goalMode: 'number', unit: 'まい' }, { num: 0 }), '目標 0まい');
});

test('数字の目標も引き継げる。できた数は引き継がない', () => {
  const l = autoLayout(RECOMMENDED);
  const g = l.blocks.find((b) => b.kind === 'goal');
  Object.assign(g, { goalMode: 'both', showResult: true });
  const opts = carryOptions(l, { goal: { text: 'なわとび', num: 10, result: 8 } });
  const o = opts.find((x) => x.id === 'goal');
  assert.deepEqual(o.value, { text: 'なわとび', num: 10 });
  assert.equal(o.text, 'なわとび　目標 10回');
  g.goalMode = 'number';
  const n = carryOptions(l, { goal: { text: 'なわとび', num: 10 }, next: { text: '花を見る' } });
  assert.deepEqual(n.map((x) => x.id), ['goal'], '数字だけのときは「次回に向けて」の文は候補にしない');
  assert.deepEqual(n[0].value, { num: 10 });
});

test('数の記録：はじめは項目なし。数の入った項目だけを文にする', () => {
  const c = autoLayout(['photo', 'counts']).blocks.find((b) => b.kind === 'counts');
  assert.deepEqual(c.rows, []);
  const leaf = newCountRow('葉の数', 'まい');
  const red = newCountRow('赤い実の数', 'こ');
  const green = newCountRow('緑の実の数', 'こ');
  assert.notEqual(leaf.id, red.id);
  const b = { rows: [leaf, red, green] };
  assert.equal(countsText(b, { nums: { [leaf.id]: 5, [red.id]: 0, [green.id]: '' } }), '葉の数 5まい・赤い実の数 0こ');
  assert.equal(countsText(b, undefined), '');
});

test('相手のいない半分の欄は、横いっぱいになる', () => {
  const l = autoLayout(['photo', 'next', 'counts', 'feeling']);
  assert.equal(l.blocks.find((b) => b.kind === 'counts').w, 6);
  const t = autoLayout(['date', 'teacher']).blocks.find((b) => b.kind === 'teacher');
  assert.equal(t.x, 3, '先生の補足は右に置いたまま');
});
