// 書き出し（控え）と戻すの決まりを確かめる
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  crc32, makeZip, readZip, buildManifest, validateBackup, planMerge, applyMerge, makeTrashCopy,
  backupFileName, MANIFEST, photoPath, thumbPath,
} from '../js/backup.js';
import { autoLayout, RECOMMENDED } from '../js/kinds.js';
import { photoIdsInUse } from '../js/records.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const join = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const clone = (x) => JSON.parse(JSON.stringify(x));

// ---------- 例のデータ ----------

const layout = autoLayout(RECOMMENDED);
function sampleBook(over = {}) {
  return { id: 'b1', title: 'トマトを育てよう', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', template: clone(layout), goalChoices: ['葉を数える'], ...over };
}
function sampleSheet(over = {}) {
  return {
    id: 's1', bookId: 'b1', no: 1, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
    layout: clone(layout), values: { title: { text: '種まき' }, photo: { photoIds: ['p1'] } }, ...over,
  };
}
const photoMeta = (id, sheetId) => ({ id, sheetId, width: 1600, height: 1200, createdAt: '2026-10-01T00:00:00Z', hasThumb: true });

// 控えのファイルを作る（アプリの書き出しと同じ組み立て）
function makeBackupFile({ books, sheets, photos }) {
  const m = buildManifest({ books, sheets, photos, scope: 'all', now: '2026-10-14T00:00:00Z' });
  const entries = [{ name: MANIFEST, data: enc.encode(JSON.stringify(m)) }];
  for (const p of photos) {
    entries.push({ name: photoPath(p.id), data: enc.encode(`JPEG ${p.id}`) });
    entries.push({ name: thumbPath(p.id), data: enc.encode(`thumb ${p.id}`) });
  }
  return join(makeZip(entries));
}

// 小さな「iPadの中」
function fakeStore({ books = [], sheets = [], photos = [] } = {}) {
  const st = {
    books: new Map(books.map((b) => [b.id, clone(b)])),
    sheets: new Map(sheets.map((s) => [s.id, clone(s)])),
    photos: new Map(photos.map((p) => [p.id, { ...p }])),
  };
  st.api = {
    putBook: async (b) => { st.books.set(b.id, clone(b)); },
    putSheet: async (s) => {
      // ページより先に写真が入っていること（写真のないページを作らない）
      for (const id of photoIdsInUse(s.values)) assert.ok(st.photos.has(id), `ページ ${s.id} の写真 ${id} が先に保存されている`);
      st.sheets.set(s.id, clone(s));
    },
    putPhoto: async (p) => { st.photos.set(p.id, { ...p }); },
    getPhoto: async (id) => st.photos.get(id) || null,
    photosOf: async (sheetId) => [...st.photos.values()].filter((p) => p.sheetId === sheetId),
    removePhoto: async (id) => { st.photos.delete(id); },
  };
  return st;
}

// すべてのページの写真が、そのページの写真として残っていること
function assertPhotosIntact(st) {
  for (const s of st.sheets.values()) {
    for (const id of photoIdsInUse(s.values)) {
      const p = st.photos.get(id);
      assert.ok(p, `ページ ${s.id} の写真 ${id} がある`);
      assert.equal(p.sheetId, s.id, `写真 ${id} は ページ ${s.id} のもの`);
    }
  }
}

let n = 0;
const newId = () => `new${++n}`;
const incomingPhotosFrom = (files, manifest) => new Map(manifest.photos.map((p) => [p.id, {
  meta: { id: p.id, sheetId: p.sheetId, width: p.width, height: p.height, createdAt: p.createdAt },
  blob: dec.decode(files.get(p.file)), thumb: p.thumb ? dec.decode(files.get(p.thumb)) : null,
}]));

// ---------- zip ----------

test('CRC32 は決まった値になる', () => {
  assert.equal(crc32(enc.encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array()), 0);
});

test('zip：書いて読むと、日本語の名前も中身もそのまま', () => {
  const bin = new Uint8Array(256).map((_, i) => i);
  const files = readZip(join(makeZip([
    { name: 'kiroku.json', data: enc.encode('{"a":"トマト"}') },
    { name: 'photos/写真.jpg', data: bin },
    { name: 'empty.txt', data: new Uint8Array() },
  ])));
  assert.deepEqual([...files.keys()], ['kiroku.json', 'photos/写真.jpg', 'empty.txt']);
  assert.equal(dec.decode(files.get('kiroku.json')), '{"a":"トマト"}');
  assert.deepEqual([...files.get('photos/写真.jpg')], [...bin]);
  assert.equal(files.get('empty.txt').length, 0);
});

test('zip：控えでないファイル・こわれたファイルは、わかる言葉で断る', () => {
  assert.throws(() => readZip(enc.encode('ただの文字')), /控えのファイルとして読めませんでした/);
  const z = join(makeZip([{ name: 'a.txt', data: enc.encode('こんにちは') }]));
  const broken = z.slice();
  broken[30 + 'a.txt'.length] ^= 0xff; // 中身（名前のすぐ後ろ）を1文字こわす
  assert.throws(() => readZip(broken), /こわれています/);
  assert.throws(() => readZip(z.slice(0, z.length - 30)), /控えのファイルとして読めませんでした/);
});

// ---------- 控えの中身の確かめ ----------

test('正しい控えは通る', () => {
  const bytes = makeBackupFile({ books: [sampleBook()], sheets: [sampleSheet()], photos: [photoMeta('p1', 's1')] });
  const files = readZip(bytes);
  const m = JSON.parse(dec.decode(files.get(MANIFEST)));
  assert.deepEqual(validateBackup(m, (name) => files.has(name)), { ok: true, errors: [] });
});

test('別のアプリ・新しい版・写真の本体がない・様式がこわれた控えは断る', () => {
  const m = buildManifest({ books: [sampleBook()], sheets: [sampleSheet()], photos: [photoMeta('p1', 's1')], scope: 'all', now: 'x' });
  const all = () => true;
  assert.equal(validateBackup({ ...m, app: 'other' }, all).ok, false);
  assert.match(validateBackup({ ...m, format: 99 }, all).errors[0], /新しい版/);
  assert.match(validateBackup(m, (name) => !name.startsWith('photos/')).errors.join(), /写真の本体/);
  const badLayout = clone(m);
  badLayout.sheets[0].layout.blocks[0].x = 9; // シートからはみ出す
  assert.match(validateBackup(badLayout, all).errors.join(), /位置がこわれています/);
  const unknownKind = clone(m);
  unknownKind.books[0].template.blocks[0].kind = 'script';
  assert.match(validateBackup(unknownKind, all).errors.join(), /知らない欄/);
  const missingPhoto = clone(m);
  missingPhoto.photos = [];
  assert.match(validateBackup(missingPhoto, all).errors.join(), /写真が、控えに入っていません/);
});

// ---------- 合わせる（戻す） ----------

test('空のiPadに戻すと、単元・ページ・写真がそろう（アイコンを消したあと）', async () => {
  const bytes = makeBackupFile({ books: [sampleBook()], sheets: [sampleSheet()], photos: [photoMeta('p1', 's1')] });
  const files = readZip(bytes);
  const m = JSON.parse(dec.decode(files.get(MANIFEST)));
  const st = fakeStore();
  const plan = planMerge({ books: [], sheets: [] }, m);
  assert.deepEqual(plan.summary, { addBooks: 1, replaceBooks: 0, addSheets: 1, sameSheets: 0, useIncoming: 0, keepLocal: 0 });
  await applyMerge(plan, { store: st.api, incomingPhotos: incomingPhotosFrom(files, m), newId, now: 'T' });
  assert.equal(st.books.get('b1').title, 'トマトを育てよう');
  assert.deepEqual(st.books.get('b1').goalChoices, ['葉を数える']);
  assert.equal(st.sheets.get('s1').values.title.text, '種まき');
  assert.equal(st.photos.get('p1').blob, 'JPEG p1');
  assertPhotosIntact(st);
});

test('同じ控えを2回戻しても、ふえない・こわれない', async () => {
  const bytes = makeBackupFile({ books: [sampleBook()], sheets: [sampleSheet()], photos: [photoMeta('p1', 's1')] });
  const files = readZip(bytes);
  const m = JSON.parse(dec.decode(files.get(MANIFEST)));
  const st = fakeStore();
  const opts = { store: st.api, incomingPhotos: incomingPhotosFrom(files, m), newId, now: 'T' };
  await applyMerge(planMerge({ books: [], sheets: [] }, m), opts);
  const plan2 = planMerge({ books: [...st.books.values()], sheets: [...st.sheets.values()] }, m);
  assert.equal(plan2.summary.sameSheets, 1);
  await applyMerge(plan2, opts);
  assert.equal(st.sheets.size, 1);
  assert.equal(st.photos.size, 1);
});

test('控えのほうが新しいページ：控えに入れかえ、今のページはごみ箱へ（写真ごと）', async () => {
  const local = sampleSheet({ updatedAt: '2026-10-02T00:00:00Z', values: { title: { text: '古い' }, photo: { photoIds: ['pOld'] } } });
  const incoming = sampleSheet({ updatedAt: '2026-10-05T00:00:00Z', values: { title: { text: '新しい' }, photo: { photoIds: ['p1'] } } });
  const st = fakeStore({ books: [sampleBook()], sheets: [local], photos: [{ ...photoMeta('pOld', 's1'), blob: 'OLD' }] });
  const bytes = makeBackupFile({ books: [sampleBook()], sheets: [incoming], photos: [photoMeta('p1', 's1')] });
  const files = readZip(bytes);
  const m = JSON.parse(dec.decode(files.get(MANIFEST)));
  const plan = planMerge({ books: [...st.books.values()], sheets: [...st.sheets.values()] }, m);
  assert.equal(plan.summary.useIncoming, 1);
  await applyMerge(plan, { store: st.api, incomingPhotos: incomingPhotosFrom(files, m), newId, now: '2026-10-14T00:00:00Z' });
  assert.equal(st.sheets.get('s1').values.title.text, '新しい');
  assert.equal(st.sheets.get('s1').deletedAt, undefined);
  const trash = [...st.sheets.values()].filter((s) => s.deletedAt);
  assert.equal(trash.length, 1, '古いほうはごみ箱に1つ');
  assert.equal(trash[0].values.title.text, '古い');
  assert.equal(trash[0].copyOf, 's1');
  const copyPhoto = st.photos.get(trash[0].values.photo.photoIds[0]);
  assert.equal(copyPhoto.blob, 'OLD', '古いページの写真も一緒に残る');
  assert.equal(st.photos.has('pOld'), false, '元の場所の写真は、写しへ移したので片づけ');
  assertPhotosIntact(st);
});

test('今のほうが新しいページ：今のまま。控えのほうをごみ箱へ（何も消えない）', async () => {
  const local = sampleSheet({ updatedAt: '2026-10-09T00:00:00Z', values: { title: { text: '今' }, photo: { photoIds: ['p1'] } } });
  const incoming = sampleSheet({ updatedAt: '2026-10-03T00:00:00Z', values: { title: { text: '控え' }, photo: { photoIds: ['p2'] } } });
  const st = fakeStore({ books: [sampleBook()], sheets: [local], photos: [{ ...photoMeta('p1', 's1'), blob: 'NOW' }] });
  const bytes = makeBackupFile({ books: [sampleBook()], sheets: [incoming], photos: [photoMeta('p2', 's1')] });
  const files = readZip(bytes);
  const m = JSON.parse(dec.decode(files.get(MANIFEST)));
  const plan = planMerge({ books: [...st.books.values()], sheets: [...st.sheets.values()] }, m);
  assert.equal(plan.summary.keepLocal, 1);
  await applyMerge(plan, { store: st.api, incomingPhotos: incomingPhotosFrom(files, m), newId, now: 'T' });
  assert.equal(st.sheets.get('s1').values.title.text, '今');
  assert.equal(st.photos.get('p1').blob, 'NOW');
  const trash = [...st.sheets.values()].filter((s) => s.deletedAt);
  assert.equal(trash.length, 1);
  assert.equal(trash[0].values.title.text, '控え');
  assert.equal(st.photos.get(trash[0].values.photo.photoIds[0]).blob, 'JPEG p2');
  assertPhotosIntact(st);
});

test('戻しても、iPadにだけある単元・ページは消えない', async () => {
  const onlyHere = sampleSheet({ id: 'sHere', no: 2, values: { title: { text: 'ここだけ' } } });
  const otherBook = sampleBook({ id: 'b2', title: '織り機' });
  const st = fakeStore({ books: [sampleBook(), otherBook], sheets: [onlyHere] });
  const bytes = makeBackupFile({ books: [sampleBook()], sheets: [sampleSheet()], photos: [photoMeta('p1', 's1')] });
  const files = readZip(bytes);
  const m = JSON.parse(dec.decode(files.get(MANIFEST)));
  await applyMerge(planMerge({ books: [...st.books.values()], sheets: [...st.sheets.values()] }, m),
    { store: st.api, incomingPhotos: incomingPhotosFrom(files, m), newId, now: 'T' });
  assert.ok(st.sheets.has('sHere'));
  assert.ok(st.books.has('b2'));
  assert.ok(st.sheets.has('s1'));
  assertPhotosIntact(st);
});

test('単元：控えのほうが新しければ入れかえ、古ければ今のまま', () => {
  const plan = planMerge(
    { books: [sampleBook({ updatedAt: '2026-10-05T00:00:00Z', title: '今' })], sheets: [] },
    { books: [sampleBook({ updatedAt: '2026-10-03T00:00:00Z', title: '控え' })], sheets: [] },
  );
  assert.equal(plan.books[0].action, 'keep');
  const plan2 = planMerge(
    { books: [sampleBook({ updatedAt: '2026-10-01T00:00:00Z' })], sheets: [] },
    { books: [sampleBook({ updatedAt: '2026-10-03T00:00:00Z' })], sheets: [] },
  );
  assert.equal(plan2.books[0].action, 'replace');
});

test('ごみ箱の写しは、新しいidで、写真のidも付けかわる', () => {
  const s = sampleSheet();
  const copy = makeTrashCopy(s, 'c1', 'T', new Map([['p1', 'q1']]));
  assert.equal(copy.id, 'c1');
  assert.equal(copy.deletedAt, 'T');
  assert.equal(copy.copyOf, 's1');
  assert.deepEqual(copy.values.photo.photoIds, ['q1']);
  assert.deepEqual(s.values.photo.photoIds, ['p1'], '元のページは変わらない');
});

test('ファイルの名前', () => {
  assert.equal(backupFileName('2026-10-14'), '記録ベース_控え_2026-10-14.zip');
  assert.equal(backupFileName('2026-10-14', 'トマト/育てよう?'), '記録ベース_控え_トマト育てよう_2026-10-14.zip');
});
