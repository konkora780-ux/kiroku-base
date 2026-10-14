// 端末内の保存（IndexedDB）。記録はこのiPadの中だけに置き、外へは送らない。
// ストア：books（単元）, sheets（ページ）, photos（写真の本体）, meta（設定）

const DB_NAME = 'kiroku-base';
const DB_VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('sheets')) db.createObjectStore('sheets', { keyPath: 'id' }).createIndex('bookId', 'bookId');
      if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' }).createIndex('sheetId', 'sheetId');
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  dbp.catch(() => { dbp = null; });
  return dbp;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('abort'));
  });
}

function result(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function get(store, id) {
  const db = await open();
  return result(db.transaction(store).objectStore(store).get(id));
}

export async function all(store) {
  const db = await open();
  return result(db.transaction(store).objectStore(store).getAll());
}

export async function byIndex(store, index, value) {
  const db = await open();
  return result(db.transaction(store).objectStore(store).index(index).getAll(value));
}

// 書きこみは、完了（ディスクに入った）まで待ってから返す
export async function put(store, obj) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(obj);
  await done(tx);
  return obj;
}

export async function remove(store, id) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(id);
  await done(tx);
}

export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---- まとまった操作 ----

export async function liveBooks() {
  return (await all('books')).filter((b) => !b.deletedAt);
}

export async function sheetsOf(bookId, { withDeleted = false } = {}) {
  const list = await byIndex('sheets', 'bookId', bookId);
  return list.filter((s) => withDeleted || !s.deletedAt).sort((a, b) => a.no - b.no);
}

export async function photosOf(sheetId) {
  return byIndex('photos', 'sheetId', sheetId);
}

// 使っていない写真を消す。ページの読み取りと写真の削除を、1つのまとまり（トランザクション）で行う。
// pick(保存されているページ, そのページの写真idの一覧) が、消す写真のidを返す
export async function removeUnusedPhotos(sheetId, pick) {
  const db = await open();
  const tx = db.transaction(['sheets', 'photos'], 'readwrite');
  const photos = tx.objectStore('photos');
  const [sheet, ids] = await Promise.all([
    result(tx.objectStore('sheets').get(sheetId)),
    result(photos.index('sheetId').getAllKeys(sheetId)),
  ]);
  for (const id of pick(sheet, ids)) photos.delete(id);
  await done(tx);
}

// ごみ箱を経由しない本当の削除（ごみ箱を空にするときだけ使う）
export async function purgeSheet(sheetId) {
  for (const p of await photosOf(sheetId)) await remove('photos', p.id);
  await remove('sheets', sheetId);
}

export async function purgeBook(bookId) {
  for (const s of await sheetsOf(bookId, { withDeleted: true })) await purgeSheet(s.id);
  await remove('books', bookId);
}

// 設定（meta）の読み書き
export async function getMeta(key) {
  const row = await get('meta', key);
  return row ? row.value : null;
}

export async function setMeta(key, value) {
  await put('meta', { key, value });
}

// ブラウザに「このデータを消さないで」と申し出る
export async function askPersist() {
  try {
    if (!navigator.storage || !navigator.storage.persist) return null;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}

export async function usage() {
  try {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    return await navigator.storage.estimate();
  } catch {
    return null;
  }
}
