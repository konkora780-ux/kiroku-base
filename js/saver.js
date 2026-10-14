// 保存係：変更を順番に、確実に保存する。
// - 変更のたびに番号（世代）を1つ進め、保存できた番号を覚える。最新の番号まで保存できたら「保存済み」
// - 保存は同時に1つだけ。保存中に変更があれば、終わってからもう一度保存する
// - 失敗は flush() の戻り値（false）で知らせる。画面を離れるときは、これを見て移動を止める
// - 画面を離れたら dispose() し、古い画面の再試行が新しい記録を上書きしないようにする

export function makeSaver({ write, onStatus = () => {}, delay = 150, retryMs = 3000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let gen = 0; // 変更の番号
  let savedGen = 0; // 保存できた番号
  let running = null; // 保存中の Promise
  let timer = null;
  let retry = null;
  let disposed = false;

  const status = (s) => { if (!disposed) onStatus(s); };

  async function writeOnce() {
    const g = gen;
    // write() は呼んだ時点の中身を保存する（IndexedDB は put した瞬間に写しを取る）
    await write();
    if (g > savedGen) savedGen = g;
  }

  // 最新の変更まで保存する。保存できたら true、できなければ false
  async function flush() {
    clearTimer(timer);
    timer = null;
    while (savedGen < gen) {
      if (running) {
        try { await running; } catch { /* 下でもう一度ためす */ }
        continue;
      }
      status('saving');
      running = writeOnce();
      try {
        await running;
      } catch (e) {
        running = null;
        status('error');
        if (!disposed) {
          clearTimer(retry);
          retry = setTimer(() => { retry = null; flush(); }, retryMs);
        }
        return false;
      }
      running = null;
    }
    status('saved');
    return true;
  }

  // 変更があった。now なら すぐ保存、そうでなければ少し待ってまとめて保存
  function changed(now = false) {
    // 画面を離れた後の変更は受けつけない（古い画面が新しい記録を上書きしないように）
    if (disposed) return now ? Promise.resolve(false) : null;
    gen++;
    status('saving');
    clearTimer(timer);
    if (now) return flush();
    timer = setTimer(() => { timer = null; flush(); }, delay);
    return null;
  }

  function dispose() {
    disposed = true;
    clearTimer(timer);
    clearTimer(retry);
    timer = null;
    retry = null;
  }

  return {
    changed,
    flush,
    dispose,
    get pending() { return savedGen < gen; },
  };
}
