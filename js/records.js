// 記録の中身についての決まり（画面に関係しない。node --test で確かめる）
// - 写真の片づけ：保存されているページを基準にする
// - 写真の付け方：処理の間に中身が入れかわっても、いまの中身に付ける。1まいずつ順番に
// - 目標の候補：保存できるまで閉じない。失敗しても候補と書きかけの文をのこす

// ページの中身で使っている写真のid（配置から外した欄の中身も「使っている」に数える）
export function photoIdsInUse(values) {
  const used = new Set();
  for (const v of Object.values(values || {})) for (const id of (v && v.photoIds) || []) used.add(id);
  return used;
}

// 消してよい写真：保存されているページ（savedSheet）で使っていない写真だけ。
// 画面の中身（まだ保存していない変更）は見ない。ページが見つからなければ何も消さない
export function unusedPhotoIds(savedSheet, photoIds) {
  if (!savedSheet) return [];
  const used = photoIdsInUse(savedSheet.values);
  return (photoIds || []).filter((id) => !used.has(id));
}

// 写真を欄に付ける。page.values は呼んだ時点のもの（「もどす」で入れかわっていても、いまの中身）を使う。
// slot：入れかえる写真の番号（null なら後ろに足す。いっぱいなら最後と入れかえる）
export function attachPhoto(page, blockId, photoId, max, slot = null) {
  const cur = page.values[blockId] || (page.values[blockId] = {});
  const ids = (cur.photoIds || []).slice(0, max);
  if (slot !== null && slot < ids.length) ids[slot] = photoId;
  else if (ids.length >= max) ids[max - 1] = photoId;
  else ids.push(photoId);
  cur.photoIds = ids;
  return ids;
}

// 写真を1まい足す作業。process() が写真を縮小・保存して、できた写真のidを返す。
// 付ける先は、処理が終わった時点の page.values（途中で「もどす」があっても、いまの中身）。
// 始めた時点の中身をとっておいて付けると、写真が記録に入らない（再評価の2）
export async function addPhotoToPage({ page, blockId, max, slot = null, process, beforeAttach }) {
  const photoId = await process();
  if (beforeAttach) beforeAttach();
  return attachPhoto(page, blockId, photoId, max, slot);
}

// 作業を1つずつ順番に行う係（写真の縮小・保存）。busy の間は「もどす」や画面の移動を待ってもらう
export function makeQueue() {
  let tail = Promise.resolve();
  let running = 0;
  return {
    run(fn) {
      running++;
      const job = tail.then(fn);
      const done = () => { running--; };
      tail = job.then(done, done);
      return job;
    },
    get busy() { return running > 0; },
    // いま並んでいる作業がすべて終わるまで待つ（失敗した作業があっても止まらない）
    idle() { return tail; },
  };
}

// 目標の候補の編集。write(items) で保存する。保存できるまで close() は false を返す
export function makeChoiceEditor({ items, write }) {
  let unsaved = false;
  async function save() {
    try {
      await write(items);
      unsaved = false;
    } catch (e) {
      unsaved = true;
    }
    return !unsaved;
  }
  return {
    items,
    get unsaved() { return unsaved; },
    // 足す。保存できなければ keepInput: true（書きかけの文を消さない）
    async add(text) {
      const t = (text || '').trim();
      if (!t) return { ok: !unsaved, keepInput: false };
      if (!items.includes(t)) items.push(t);
      const ok = await save();
      return { ok, keepInput: !ok };
    },
    async remove(i) {
      items.splice(i, 1);
      return save();
    },
    async moveUp(i) {
      if (i <= 0 || i >= items.length) return !unsaved;
      [items[i - 1], items[i]] = [items[i], items[i - 1]];
      return save();
    },
    // 閉じてよいか。未保存なら、もう一度保存してみる
    async close() {
      return unsaved ? save() : true;
    },
  };
}
