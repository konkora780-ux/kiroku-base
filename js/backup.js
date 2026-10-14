// 記録の書き出し（控え）と、控えから戻す。画面に関係しない部分（node --test で確かめる）
//
// 控えのファイル：zip（圧縮なし）。中身は
//   kiroku.json      … 単元・ページ・写真の情報（文章や様式はここ）
//   photos/ID.jpg    … 写真の本体
//   thumbs/ID.jpg    … 一覧用の小さい写真
//
// 戻すときは「合わせる」：足りない記録を足す。同じページは新しいほうを残し、古いほうはごみ箱へ。何も消さない
import { KINDS, inBounds } from './kinds.js';
import { photoIdsInUse, unusedPhotoIds } from './records.js';

export const BACKUP_APP = 'kiroku-base';
export const BACKUP_FORMAT = 1;
export const MANIFEST = 'kiroku.json';

// ---------- zip（圧縮なし） ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// entries: [{ name, data: Uint8Array }] → zip の部品の配列（new Blob(parts) で1つのファイルになる。大きな写真をつなげ直さないため）
export function makeZip(entries) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const data = e.data;
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const v = new DataView(local.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(6, 0x0800, true); // 名前は UTF-8
    v.setUint16(8, 0, true); // 圧縮なし
    v.setUint16(10, 0, true);
    v.setUint16(12, 0x21, true); // 1980-01-01
    v.setUint32(14, crc, true);
    v.setUint32(18, data.length, true);
    v.setUint32(22, data.length, true);
    v.setUint16(26, name.length, true);
    v.setUint16(28, 0, true);
    local.set(name, 30);
    parts.push(local, data);

    const cen = new Uint8Array(46 + name.length);
    const c = new DataView(cen.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, 0, true);
    c.setUint16(14, 0x21, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true);
    c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    cen.set(name, 46);
    central.push(cen);
    offset += local.length + data.length;
  }
  const cenSize = central.reduce((n, x) => n + x.length, 0);
  const end = new Uint8Array(22);
  const d = new DataView(end.buffer);
  d.setUint32(0, 0x06054b50, true);
  d.setUint16(8, entries.length, true);
  d.setUint16(10, entries.length, true);
  d.setUint32(12, cenSize, true);
  d.setUint32(16, offset, true);
  return [...parts, ...central, end];
}

// zip を読む → Map（名前 → 中身）。控えのファイルでなければ、わかる言葉でエラーにする
export function readZip(bytes) {
  const bad = (why) => new Error(`控えのファイルとして読めませんでした（${why}）`);
  if (!(bytes instanceof Uint8Array) || bytes.length < 22) throw bad('ファイルが小さすぎます');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw bad('zip ではありません');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) throw bad('目次がこわれています');
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const at = view.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (method !== 0 || (flags & 1)) throw bad('このアプリで作った控えではありません');
    if (at + 30 > bytes.length || view.getUint32(at, true) !== 0x04034b50) throw bad('中身がこわれています');
    const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
    if (start + size > bytes.length) throw bad('ファイルが途中で切れています');
    const data = bytes.subarray(start, start + size);
    if (crc32(data) !== crc) throw bad(`「${name}」がこわれています`);
    files.set(name, data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// ---------- 控えの中身（kiroku.json） ----------

export function photoPath(id) { return `photos/${id}.jpg`; }
export function thumbPath(id) { return `thumbs/${id}.jpg`; }

// photos は写真の情報だけ（本体は別に zip に入れる）
export function buildManifest({ books, sheets, photos, scope, now }) {
  return {
    app: BACKUP_APP,
    format: BACKUP_FORMAT,
    exportedAt: now,
    scope,
    books,
    sheets,
    photos: photos.map((p) => ({
      id: p.id, sheetId: p.sheetId, width: p.width, height: p.height, createdAt: p.createdAt,
      file: photoPath(p.id), thumb: p.hasThumb ? thumbPath(p.id) : null,
    })),
  };
}

const KIND_SET = new Set(KINDS.map((k) => k.kind));
const isStr = (x) => typeof x === 'string' && x.length > 0;

function layoutErrors(layout, where) {
  if (!layout || !Array.isArray(layout.blocks)) return [`${where}の様式が読めません`];
  for (const b of layout.blocks) {
    if (!b || !isStr(b.id) || !KIND_SET.has(b.kind)) return [`${where}の様式に、知らない欄があります`];
    if (![b.x, b.y, b.w, b.h].every(Number.isInteger) || !inBounds(b)) return [`${where}の様式の位置がこわれています`];
  }
  return [];
}

// 控えの中身を確かめる。has(name) は zip にそのファイルがあるか。{ ok, errors }
export function validateBackup(m, has) {
  const errors = [];
  if (!m || typeof m !== 'object' || m.app !== BACKUP_APP) return { ok: false, errors: ['記録ベースの控えではありません'] };
  if (m.format > BACKUP_FORMAT) return { ok: false, errors: ['新しい版の記録ベースで作った控えです。アプリを新しくしてから戻してください'] };
  if (m.format !== BACKUP_FORMAT) return { ok: false, errors: ['控えの形が読めません'] };
  if (!Array.isArray(m.books) || !Array.isArray(m.sheets) || !Array.isArray(m.photos)) return { ok: false, errors: ['控えの中身が足りません'] };
  const bookIds = new Set();
  for (const b of m.books) {
    if (!b || !isStr(b.id) || typeof b.title !== 'string') { errors.push('単元の情報がこわれています'); continue; }
    bookIds.add(b.id);
    errors.push(...layoutErrors(b.template, `単元「${b.title}」`));
  }
  const sheetIds = new Set();
  for (const s of m.sheets) {
    if (!s || !isStr(s.id) || !isStr(s.bookId) || !Number.isInteger(s.no) || !s.values || typeof s.values !== 'object') { errors.push('ページの情報がこわれています'); continue; }
    if (!bookIds.has(s.bookId)) errors.push(`${s.no}まいめの単元が、控えに入っていません`);
    sheetIds.add(s.id);
    errors.push(...layoutErrors(s.layout, `${s.no}まいめ`));
  }
  const photoIds = new Set();
  for (const p of m.photos) {
    if (!p || !isStr(p.id) || !isStr(p.sheetId) || !isStr(p.file)) { errors.push('写真の情報がこわれています'); continue; }
    if (!has(p.file)) errors.push('写真の本体が控えに入っていません');
    if (p.thumb && !has(p.thumb)) errors.push('小さい写真が控えに入っていません');
    photoIds.add(p.id);
  }
  // ページが使っている写真が、控えに入っているか
  for (const s of m.sheets) {
    if (!s || !s.values) continue;
    for (const id of photoIdsInUse(s.values)) if (!photoIds.has(id)) { errors.push(`${s.no}まいめの写真が、控えに入っていません`); break; }
  }
  const uniq = [...new Set(errors)];
  return { ok: uniq.length === 0, errors: uniq.slice(0, 5) };
}

// ---------- 合わせる（戻す） ----------

const newer = (a, b) => String(a.updatedAt || '') > String(b.updatedAt || '');
const sameContent = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 何をするかの計画。local・incoming：{ books, sheets }
// 単元：ない→足す／控えのほうが新しい→入れかえる／それ以外→今のまま
// ページ：ない→足す／同じ→何もしない／控えのほうが新しい→入れかえて、今のほうをごみ箱へ（写し）
//        今のほうが新しい（または同じ日時で中身がちがう）→今のまま、控えのほうをごみ箱へ（写し）
export function planMerge(local, incoming) {
  const lb = new Map(local.books.map((b) => [b.id, b]));
  const ls = new Map(local.sheets.map((s) => [s.id, s]));
  const books = incoming.books.map((b) => {
    const cur = lb.get(b.id);
    if (!cur) return { action: 'add', incoming: b };
    if (newer(b, cur)) return { action: 'replace', incoming: b, local: cur };
    return { action: 'keep', incoming: b, local: cur };
  });
  const sheets = incoming.sheets.map((s) => {
    const cur = ls.get(s.id);
    if (!cur) return { action: 'add', incoming: s };
    if (sameContent(s, cur)) return { action: 'same', incoming: s, local: cur };
    if (newer(s, cur)) return { action: 'useIncoming', incoming: s, local: cur };
    return { action: 'keepLocal', incoming: s, local: cur };
  });
  const count = (list, a) => list.filter((x) => x.action === a).length;
  return {
    books,
    sheets,
    summary: {
      addBooks: count(books, 'add'),
      replaceBooks: count(books, 'replace'),
      addSheets: count(sheets, 'add'),
      sameSheets: count(sheets, 'same'),
      useIncoming: count(sheets, 'useIncoming'),
      keepLocal: count(sheets, 'keepLocal'),
    },
  };
}

// ごみ箱に入れる「写し」を作る（新しいid。写真のidも付けかえる）
export function makeTrashCopy(sheet, newId, now, photoIdMap) {
  const copy = JSON.parse(JSON.stringify(sheet));
  copy.id = newId;
  copy.copyOf = sheet.id;
  copy.deletedAt = now;
  for (const v of Object.values(copy.values || {})) {
    if (v && Array.isArray(v.photoIds)) v.photoIds = v.photoIds.map((id) => photoIdMap.get(id) || id);
  }
  return copy;
}

// 計画どおりに書きこむ。
// store：{ putBook, putSheet, putPhoto, getPhoto(id), photosOf(sheetId), removePhoto(id) }（どれも Promise）
// incomingPhotos：Map（写真id → { meta, blob, thumb }）
// 写真は、ページより先に保存する（ページが、まだない写真を指さないように）
export async function applyMerge(plan, { store, incomingPhotos, newId, now }) {
  const done = { addBooks: 0, replaceBooks: 0, addSheets: 0, useIncoming: 0, keepLocal: 0, photos: 0 };

  const putIncomingPhotos = async (sheet) => {
    for (const id of photoIdsInUse(sheet.values)) {
      if (await store.getPhoto(id)) continue;
      const src = incomingPhotos.get(id);
      if (!src) continue;
      await store.putPhoto({ ...src.meta, id, sheetId: sheet.id, blob: src.blob, thumb: src.thumb || src.blob });
      done.photos++;
    }
  };
  // 写しをごみ箱へ。fromLocal なら今のiPadの写真、そうでなければ控えの写真を使う
  const copyToTrash = async (sheet, fromLocal) => {
    const copyId = newId();
    const map = new Map();
    for (const id of photoIdsInUse(sheet.values)) {
      const src = fromLocal ? await store.getPhoto(id) : (() => {
        const p = incomingPhotos.get(id);
        return p && { ...p.meta, blob: p.blob, thumb: p.thumb || p.blob };
      })();
      if (!src) continue;
      const pid = newId();
      map.set(id, pid);
      await store.putPhoto({ ...src, id: pid, sheetId: copyId });
      done.photos++;
    }
    await store.putSheet(makeTrashCopy(sheet, copyId, now, map));
  };

  for (const b of plan.books) {
    if (b.action === 'add') { await store.putBook(b.incoming); done.addBooks++; }
    if (b.action === 'replace') { await store.putBook(b.incoming); done.replaceBooks++; }
  }
  for (const s of plan.sheets) {
    if (s.action === 'add') {
      await putIncomingPhotos(s.incoming);
      await store.putSheet(s.incoming);
      done.addSheets++;
    } else if (s.action === 'same') {
      await putIncomingPhotos(s.incoming); // 写真だけ欠けていたら足す
    } else if (s.action === 'useIncoming') {
      await copyToTrash(s.local, true);
      await putIncomingPhotos(s.incoming);
      await store.putSheet(s.incoming);
      // 前の版だけが使っていた写真は、写しのほうに移したので片づける
      const ids = (await store.photosOf(s.incoming.id)).map((p) => p.id);
      for (const id of unusedPhotoIds(s.incoming, ids)) await store.removePhoto(id);
      done.useIncoming++;
    } else if (s.action === 'keepLocal') {
      await copyToTrash(s.incoming, false);
      done.keepLocal++;
    }
  }
  return done;
}

// 書き出すファイルの名前（例：記録ベース_控え_2026-10-14.zip、記録ベース_控え_トマトを育てよう_2026-10-14.zip）
export function backupFileName(day, unitTitle = null) {
  const safe = unitTitle ? unitTitle.replace(/[\\/:*?"<>|]/g, '').slice(0, 30) : '';
  return `記録ベース_控え_${safe ? `${safe}_` : ''}${day}.zip`;
}
