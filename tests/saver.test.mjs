import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSaver } from '../js/saver.js';

// 手で進められるタイマー
function fakeTimers() {
  const list = new Set();
  return {
    setTimer: (fn) => { const t = { fn }; list.add(t); return t; },
    clearTimer: (t) => list.delete(t),
    run: () => { const all = [...list]; list.clear(); all.forEach((t) => t.fn()); },
    size: () => list.size,
  };
}

test('変更をすべて保存したら「保存済み」になる', async () => {
  const t = fakeTimers();
  const saved = [];
  let doc = 0;
  const st = [];
  const s = makeSaver({ write: async () => { saved.push(doc); }, onStatus: (x) => st.push(x), ...t });
  doc = 1; s.changed();
  doc = 2; s.changed();
  assert.equal(s.pending, true);
  assert.equal(await s.flush(), true);
  assert.deepEqual(saved, [2], '少し待ってまとめて1回で保存');
  assert.equal(s.pending, false);
  assert.equal(st.at(-1), 'saved');
});

test('保存中に変更があったら、終わってからもう一度保存する', async () => {
  const t = fakeTimers();
  const saved = [];
  let doc = 'a';
  let release;
  let first = true;
  const s = makeSaver({
    write: async () => {
      const snap = doc;
      if (first) { first = false; await new Promise((r) => { release = r; }); }
      saved.push(snap);
    },
    ...t,
  });
  s.changed();
  const p1 = s.flush(); // 'a' を保存中
  doc = 'b';
  s.changed();
  const p2 = s.flush(); // 保存中の分を待ってから 'b'
  release();
  assert.equal(await p1, true);
  assert.equal(await p2, true);
  assert.deepEqual(saved, ['a', 'b']);
  assert.equal(s.pending, false);
});

test('失敗したら false を返し、未保存のまま。あとで成功すれば保存済み', async () => {
  const t = fakeTimers();
  let fail = true;
  const st = [];
  const s = makeSaver({ write: async () => { if (fail) throw new Error('容量不足'); }, onStatus: (x) => st.push(x), ...t });
  s.changed();
  assert.equal(await s.flush(), false);
  assert.equal(s.pending, true);
  assert.equal(st.at(-1), 'error');
  assert.equal(t.size(), 1, '再試行を予約');
  fail = false;
  assert.equal(await s.flush(), true);
  assert.equal(s.pending, false);
  assert.equal(st.at(-1), 'saved');
});

test('画面を離れたあと（dispose）は、古い画面の再試行が動かない', async () => {
  const t = fakeTimers();
  let calls = 0;
  const s = makeSaver({ write: async () => { calls++; throw new Error('x'); }, ...t });
  s.changed();
  await s.flush();
  s.dispose();
  assert.equal(t.size(), 0, '予約は取り消される');
  t.run();
  assert.equal(calls, 1);
});

test('変更がなければ保存しない', async () => {
  let calls = 0;
  const s = makeSaver({ write: async () => { calls++; }, ...fakeTimers() });
  assert.equal(await s.flush(), true);
  assert.equal(calls, 0);
});

test('画面を離れた後の変更は保存しない', async () => {
  let calls = 0;
  const s = makeSaver({ write: async () => { calls++; }, ...fakeTimers() });
  s.dispose();
  assert.equal(await s.changed(true), false);
  assert.equal(calls, 0);
});
