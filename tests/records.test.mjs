// 再評価（docs/codex-followup-review-2026-10-14.md）の3点が、もう一度起きないことを確かめる
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unusedPhotoIds, photoIdsInUse, attachPhoto, addPhotoToPage, makeQueue, makeChoiceEditor } from '../js/records.js';
import { makeSaver, leaveScreen } from '../js/saver.js';

const clone = (x) => JSON.parse(JSON.stringify(x));
const later = () => { let release; const p = new Promise((r) => { release = r; }); return { p, release }; };

// 手で進められるタイマー（saver の再試行を勝手に動かさないため）
function fakeTimers() {
  const list = new Set();
  return { setTimer: (fn) => { const t = { fn }; list.add(t); return t; }, clearTimer: (t) => list.delete(t) };
}

// ---------- 1. 保存せずに移っても、保存済みの写真を消さない ----------

// 小さな「端末の中」：保存されたページと写真の本体
function fakeStore() {
  const store = { sheet: { id: 's1', values: { photo: { photoIds: ['A'] } } }, photos: new Set(['A']), failPut: false };
  store.put = async (sheet) => { if (store.failPut) throw new Error('容量不足'); store.sheet = clone(sheet); };
  // アプリの片づけと同じ：保存されているページを基準に、使っていない写真を消す
  store.cleanup = async () => { for (const id of unusedPhotoIds(store.sheet, [...store.photos])) store.photos.delete(id); };
  return store;
}

// 入力画面の流れを再現する：写真を A→B に入れかえて（または外して）、画面を離れる
async function editAndLeave(store, { change, answer }) {
  const page = clone(store.sheet);
  const saver = makeSaver({ write: () => store.put(page), ...fakeTimers() });
  store.photos.add('B'); // 新しい写真は、先に本体を保存する（アプリと同じ順番）
  change(page);
  saver.changed();
  return leaveScreen({ saver, ask: async () => answer, afterLeave: () => store.cleanup() });
}

test('[1] 保存に失敗して「保存せずに移る」：前に保存した写真Aは消えない', async () => {
  const store = fakeStore();
  store.failPut = true;
  const left = await editAndLeave(store, { change: (p) => { p.values.photo.photoIds = ['B']; }, answer: 'discard' });
  assert.equal(left, true, '画面は移る');
  assert.deepEqual(store.sheet.values.photo.photoIds, ['A'], '保存済みのページはAのまま');
  assert.ok(store.photos.has('A'), '写真Aの本体が残っている（ページから参照されている）');
  for (const id of photoIdsInUse(store.sheet.values)) assert.ok(store.photos.has(id), `参照先 ${id} が残っている`);
});

test('[1] 「保存せずに移る」を選んだときは、片づけ（写真の削除）そのものを行わない', async () => {
  const store = fakeStore();
  store.failPut = true;
  let cleaned = 0;
  const page = clone(store.sheet);
  const saver = makeSaver({ write: () => store.put(page), ...fakeTimers() });
  page.values.photo.photoIds = ['B'];
  saver.changed();
  const left = await leaveScreen({ saver, ask: async () => 'discard', afterLeave: async () => { cleaned++; } });
  assert.equal(left, true);
  assert.equal(cleaned, 0, '画面の中身（未保存）を根拠に写真を消さない');
});

test('[1] 「写真を外す」で保存に失敗し、保存せずに移っても、写真Aは消えない', async () => {
  const store = fakeStore();
  store.failPut = true;
  await editAndLeave(store, { change: (p) => { p.values.photo.photoIds = []; }, answer: 'discard' });
  assert.ok(store.photos.has('A'));
});

test('[1] ふつうに保存できたときは、Bが残り、使わなくなったAは片づけられる', async () => {
  const store = fakeStore();
  await editAndLeave(store, { change: (p) => { p.values.photo.photoIds = ['B']; }, answer: 'discard' });
  assert.deepEqual(store.sheet.values.photo.photoIds, ['B']);
  assert.deepEqual([...store.photos], ['B']);
});

test('[1] 失敗のあと「もう一度」で保存できたときは、片づけをする', async () => {
  const store = fakeStore();
  store.failPut = true;
  const page = clone(store.sheet);
  const saver = makeSaver({ write: () => store.put(page), ...fakeTimers() });
  store.photos.add('B');
  page.values.photo.photoIds = ['B'];
  saver.changed();
  const left = await leaveScreen({
    saver,
    ask: async () => { store.failPut = false; return (await saver.flush()) ? 'saved' : false; },
    afterLeave: () => store.cleanup(),
  });
  assert.equal(left, true);
  assert.deepEqual([...store.photos], ['B']);
});

test('[1] 「この画面にのこる」：移らず、片づけもしない。保存係もそのまま使える', async () => {
  const store = fakeStore();
  store.failPut = true;
  let cleaned = false;
  const page = clone(store.sheet);
  const saver = makeSaver({ write: () => store.put(page), ...fakeTimers() });
  page.values.photo.photoIds = [];
  saver.changed();
  const left = await leaveScreen({ saver, ask: async () => false, afterLeave: () => { cleaned = true; } });
  assert.equal(left, false);
  assert.equal(cleaned, false);
  store.failPut = false;
  assert.equal(await saver.flush(), true, 'あとで保存できる');
});

test('[1] 片づけの基準は保存済みのページ。ページが見つからなければ何も消さない', () => {
  assert.deepEqual(unusedPhotoIds({ values: { photo: { photoIds: ['A'] } } }, ['A', 'B']), ['B']);
  assert.deepEqual(unusedPhotoIds({ values: { old: { photoIds: ['A'] } } }, ['A']), [], '配置から外した欄の写真も残す');
  assert.deepEqual(unusedPhotoIds(undefined, ['A', 'B']), []);
});

test('[1] 片づけに失敗しても、画面の移動は止めない', async () => {
  const saver = makeSaver({ write: async () => {}, ...fakeTimers() });
  const left = await leaveScreen({ saver, ask: async () => false, afterLeave: async () => { throw new Error('x'); } });
  assert.equal(left, true);
});

// ---------- 2. 写真の処理中に「もどす」をしても、新しい写真が記録に入る ----------

test('[2] 写真の処理中は busy。終わる（失敗しても）と busy でなくなる', async () => {
  const q = makeQueue();
  assert.equal(q.busy, false);
  const gate = later();
  const job = q.run(() => gate.p);
  assert.equal(q.busy, true, 'このあいだ「もどす」は待ってもらう');
  gate.release();
  await job;
  assert.equal(q.busy, false);
  const bad = q.run(async () => { throw new Error('写真を読めない'); });
  await assert.rejects(bad);
  await q.idle();
  assert.equal(q.busy, false, '失敗しても busy のままにならない');
});

test('[2] 処理の間に中身が入れかわっても（もどす）、写真はいまの中身に付く', async () => {
  const sheet = { values: { title: { text: 'あ' }, photo: { photoIds: ['A'] } } };
  const q = makeQueue();
  const gate = later();
  const started = later();
  let undoSnap = 0;
  const job = q.run(() => addPhotoToPage({
    page: sheet, blockId: 'photo', max: 2,
    beforeAttach: () => { undoSnap++; },
    process: async () => { started.release(); await gate.p; return 'B'; }, // 写真の縮小・保存に時間がかかっている
  }));
  await started.p; // 写真の処理が始まってから
  sheet.values = clone(sheet.values); // 「もどす」で中身のオブジェクトが入れかわる
  sheet.values.title.text = '';
  gate.release();
  await job;
  assert.deepEqual(sheet.values.photo.photoIds, ['A', 'B'], '保存される中身に写真Bが入っている');
  assert.equal(sheet.values.title.text, '', 'もどした内容はそのまま');
  assert.equal(undoSnap, 1, '付ける直前に、もどす先を記録する');
});

test('[2] 同じ欄に続けて足しても、順番に処理され、まいすうを超えない', async () => {
  const sheet = { values: { photo: { photoIds: ['A'] } } };
  const q = makeQueue();
  const order = [];
  const slow = (id, ms) => q.run(async () => {
    order.push(`start ${id}`);
    await new Promise((r) => setTimeout(r, ms));
    attachPhoto(sheet, 'photo', id, 2);
    order.push(`end ${id}`);
  });
  await Promise.all([slow('B', 20), slow('C', 1)]);
  assert.deepEqual(order, ['start B', 'end B', 'start C', 'end C'], '前の写真が終わってから次へ');
  assert.equal(sheet.values.photo.photoIds.length, 2, '2まいまで');
  assert.deepEqual(sheet.values.photo.photoIds, ['A', 'C'], 'いっぱいなら最後と入れかわる');
});

test('[2] 入れかえる写真を選んだときは、その番号と入れかわる', () => {
  const sheet = { values: { photo: { photoIds: ['A', 'B'] } } };
  attachPhoto(sheet, 'photo', 'C', 2, 0);
  assert.deepEqual(sheet.values.photo.photoIds, ['C', 'B']);
  const empty = { values: {} };
  attachPhoto(empty, 'photo', 'X', 1);
  assert.deepEqual(empty.values.photo.photoIds, ['X']);
});

// ---------- 3. 目標の候補：保存に失敗したら閉じない・消さない ----------

function choiceStore() {
  const st = { saved: [], fail: false, writes: 0 };
  st.write = async (items) => { st.writes++; if (st.fail) throw new Error('容量不足'); st.saved = [...items]; };
  return st;
}

test('[3] 足すときに失敗：書きかけの文を残し、閉じない。直ったら保存されて閉じられる', async () => {
  const st = choiceStore();
  const items = [];
  const ed = makeChoiceEditor({ items, write: st.write });
  st.fail = true;
  const r = await ed.add('実の色を見る');
  assert.equal(r.ok, false);
  assert.equal(r.keepInput, true, '入力欄の文は消さない');
  assert.equal(ed.unsaved, true);
  assert.equal(await ed.close(), false, '「できた」で閉じない');
  assert.deepEqual(items, ['実の色を見る'], '候補も消えていない');
  st.fail = false;
  assert.equal(await ed.close(), true, '直ったら、もう一度保存して閉じる');
  assert.deepEqual(st.saved, ['実の色を見る'], '開き直すと反映されている');
});

test('[3] 並べかえ・削除で失敗しても、閉じるときにもう一度保存する', async () => {
  const st = choiceStore();
  const items = ['a', 'b', 'c'];
  const ed = makeChoiceEditor({ items, write: st.write });
  st.fail = true;
  assert.equal(await ed.moveUp(2), false);
  assert.equal(await ed.remove(0), false);
  assert.deepEqual(items, ['c', 'b']);
  assert.equal(await ed.close(), false);
  st.fail = false;
  assert.equal(await ed.close(), true);
  assert.deepEqual(st.saved, ['c', 'b']);
});

test('[3] 保存できていれば、閉じるときに余分な保存はしない', async () => {
  const st = choiceStore();
  const ed = makeChoiceEditor({ items: [], write: st.write });
  const r = await ed.add('水やり');
  assert.deepEqual(r, { ok: true, keepInput: false });
  const before = st.writes;
  assert.equal(await ed.close(), true);
  assert.equal(st.writes, before);
  assert.deepEqual((await ed.add('水やり')).ok, true, '同じ候補は二重に足さない');
  assert.deepEqual(st.saved, ['水やり']);
});
