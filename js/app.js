// 記録ベース：画面と操作
import * as db from './db.js';
import {
  KINDS, RECOMMENDED, FEELING_CHOICES, COLS, ROWS, kindInfo, autoLayout, canPlace, addBlock,
  cloneLayout, carryOptions, todayISO, formatDate, GOAL_MODES, GOAL_UNITS, goalText,
  newCountRow, countsText, hasNum,
} from './kinds.js';
import { buildSheet, markOverflow, fitBox } from './sheet.js';
import { shrinkPhoto } from './photo.js';
import { makeSaver } from './saver.js';

const $bar = document.getElementById('bar');
const $view = document.getElementById('view');
const $modal = document.getElementById('modal-root');
const $toast = document.getElementById('toast');
const $print = document.getElementById('print-root');

const state = {
  teacher: false,
  photoURL: new Map(), // 写真id → 表示用URL
  thumbURL: new Map(),
  leave: null, // 画面を離れる前に呼ぶ（保存など）
};

// ---------- 小さな道具 ----------

function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k in e && typeof v !== 'string') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}

// 子要素を入れかえる（null・false は飛ばす。replaceChildren に直接わたすと「null」と表示されるため）
function fill(node, ...kids) {
  node.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
}

let toastTimer;
function toast(msg) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove('show'), 2600);
}

function modal({ title, body, buttons = [], wide = false }) {
  const close = () => { box.remove(); };
  const box = h('div', { class: 'modal-back' },
    h('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog' },
      title ? h('h2', { text: title }) : null,
      body ? (typeof body === 'string' ? h('p', { text: body }) : body) : null,
      buttons.length ? h('div', { class: 'modal-btns' },
        buttons.map((b) => h('button', { class: `btn ${b.cls || ''}`, onclick: () => { if (b.keep !== true) close(); b.onClick && b.onClick(); } }, b.label))) : null));
  $modal.append(box);
  return close;
}

function confirmBox(title, msg, okLabel, cls = 'danger') {
  return new Promise((resolve) => {
    modal({ title, body: msg, buttons: [
      { label: 'やめる', onClick: () => resolve(false) },
      { label: okLabel, cls, onClick: () => resolve(true) },
    ] });
  });
}

function promptBox(title, value = '', okLabel = '決める') {
  return new Promise((resolve) => {
    const input = h('input', { class: 'big-input', value, maxlength: '40' });
    const close = modal({ title, body: input, buttons: [
      { label: 'やめる', onClick: () => resolve(null) },
      { label: okLabel, cls: 'primary', onClick: () => resolve(input.value.trim()) },
    ] });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { close(); resolve(input.value.trim()); } });
    setTimeout(() => input.focus(), 50);
  });
}

// 押し続けたら fn（短く押しただけなら onShort）
function longPress(node, ms, fn, onShort) {
  let t = null;
  let fired = false;
  node.addEventListener('pointerdown', () => {
    fired = false;
    node.classList.add('pressing');
    t = setTimeout(() => { fired = true; node.classList.remove('pressing'); fn(); }, ms);
  });
  const cancel = () => {
    if (t) clearTimeout(t);
    t = null;
    node.classList.remove('pressing');
  };
  node.addEventListener('pointerup', () => { const was = t && !fired; cancel(); if (was && onShort) onShort(); });
  node.addEventListener('pointerleave', cancel);
  node.addEventListener('pointercancel', cancel);
  node.addEventListener('contextmenu', (e) => e.preventDefault());
}

function go(hash) { location.hash = hash; }

// ---------- 上の帯 ----------

function teacherButton() {
  const b = h('button', { class: `btn teacher-btn${state.teacher ? ' on' : ''}`, 'aria-label': '先生モード（長押し）' },
    h('span', { class: 'ring' }), state.teacher ? '先生モード中' : '先生');
  longPress(b, 900, () => {
    state.teacher = !state.teacher;
    document.body.classList.toggle('teacher', state.teacher);
    toast(state.teacher ? '先生モードにしました' : '先生モードを終わりました');
    route();
  }, () => toast(state.teacher ? '長押しすると先生モードを終わります' : '先生モードは長押しで始まります'));
  return b;
}

function setBar({ back, title, actions = [], save = false }) {
  fill($bar, 
    h('div', { class: 'bar-left' }, back ? h('button', { class: 'btn back', onclick: back }, '← もどる') : h('div', { class: 'logo' }, '📚 記録ベース')),
    h('div', { class: 'bar-title', text: title || '' }),
    h('div', { class: 'bar-right' },
      save ? h('span', { id: 'save', class: 'save', text: '' }) : null,
      ...actions,
      teacherButton()),
  );
}

function setSave(s) {
  const e = document.getElementById('save');
  if (!e) return;
  e.className = `save ${s}`;
  e.textContent = s === 'saving' ? '保存中…' : s === 'saved' ? '保存しました ✓' : s === 'error' ? '保存できませんでした' : '';
}

// ---------- 保存（画面ごと） ----------

// 保存に失敗したまま画面を離れようとしたときに聞く。true なら移ってよい
function askSaveFailed(saver) {
  return new Promise((resolve) => {
    const ask = () => modal({
      title: '保存できませんでした',
      body: 'iPadの空き容量が少ないなどの理由で、保存できませんでした。「もう一度」を押してください。',
      buttons: [
        { label: 'この画面にのこる', onClick: () => resolve(false) },
        { label: '保存せずに移る（最後の変更は消えます）', cls: 'danger', onClick: () => resolve(true) },
        { label: 'もう一度', cls: 'primary', onClick: async () => {
          if (await saver.flush()) { toast('保存しました'); resolve(true); } else ask();
        } },
      ],
    });
    ask();
  });
}

// 画面の保存係をつくる。画面を離れるときは保存が終わるまで待ち、失敗したら移動を止める
// busy：まだ終わっていない作業（写真の保存など）。画面を離れる前に終わるのを待つ
function screenSaver(write, { afterLeave, busy } = {}) {
  const saver = makeSaver({ write, onStatus: setSave });
  const onHide = () => { if (document.visibilityState === 'hidden') saver.flush(); };
  const onPageHide = () => { saver.flush(); };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', onPageHide);
  state.leave = async () => {
    if (busy && busy.size) {
      toast('写真を保存しています。少し待ってください');
      await Promise.allSettled([...busy]);
    }
    const ok = (await saver.flush()) || (await askSaveFailed(saver));
    if (!ok) return false;
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', onPageHide);
    saver.dispose();
    if (afterLeave) { try { await afterLeave(); } catch (e) { console.warn(e); } }
    return true;
  };
  return saver;
}

// ---------- 写真のURL ----------

// 表示用のURLを手放す（画面を移るたびに。開いた画面で必要な分だけ作り直す）
function releaseURLs() {
  for (const m of [state.photoURL, state.thumbURL]) {
    for (const u of m.values()) URL.revokeObjectURL(u);
    m.clear();
  }
}

// そのページで使っていない写真を消す（外した・入れかえた写真）。入力画面を離れて保存できた後にだけ呼ぶ
async function cleanupPhotos(sheet) {
  const used = new Set();
  for (const v of Object.values(sheet.values || {})) for (const id of (v && v.photoIds) || []) used.add(id);
  for (const p of await db.photosOf(sheet.id)) if (!used.has(p.id)) await db.remove('photos', p.id);
}

async function loadPhotos(sheetId) {
  for (const p of await db.photosOf(sheetId)) {
    if (!state.photoURL.has(p.id)) state.photoURL.set(p.id, URL.createObjectURL(p.blob));
    if (!state.thumbURL.has(p.id)) state.thumbURL.set(p.id, URL.createObjectURL(p.thumb || p.blob));
  }
}

function firstPhotoId(sheet) {
  for (const b of sheet.layout.blocks) {
    const ids = sheet.values[b.id] && sheet.values[b.id].photoIds;
    if (b.kind === 'photo' && ids && ids.length) return ids[0];
  }
  return null;
}

async function thumbOf(sheet) {
  const id = firstPhotoId(sheet);
  if (!id) return null;
  if (!state.thumbURL.has(id)) {
    const p = await db.get('photos', id);
    if (!p) return null;
    state.thumbURL.set(id, URL.createObjectURL(p.thumb || p.blob));
  }
  return state.thumbURL.get(id);
}

function sheetTitle(sheet) {
  return (sheet.values.title && sheet.values.title.text) || '';
}

function sheetDate(sheet) {
  return (sheet.values.date && sheet.values.date.text) || sheet.createdAt.slice(0, 10);
}

async function touchBook(bookId) {
  const book = await db.get('books', bookId);
  if (book) { book.updatedAt = new Date().toISOString(); await db.put('books', book); }
}

// ---------- 画面：ホーム ----------

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

async function home() {
  setBar({});
  const books = (await db.liveBooks()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const sheets = (await db.all('sheets')).filter((s) => !s.deletedAt);
  const grid = h('div', { class: 'cards' },
    h('button', { class: 'card new-card', onclick: () => go('#/new') }, h('div', { class: 'plus' }, '＋'), h('div', { class: 'card-title' }, '新しい単元')));
  for (const b of books) {
    const mine = sheets.filter((s) => s.bookId === b.id).sort((x, y) => y.no - x.no);
    let thumb = null;
    for (const s of mine) { thumb = await thumbOf(s); if (thumb) break; }
    grid.append(h('button', { class: 'card', onclick: () => go(`#/book/${b.id}`) },
      h('div', { class: 'cover' }, thumb ? h('img', { src: thumb, alt: '' }) : h('span', { text: '📘' })),
      h('div', { class: 'card-title', text: b.title }),
      h('div', { class: 'card-sub', text: `${mine.length} まい` })));
  }
  const parts = [];
  if (isIOS && !isStandalone) {
    parts.push(h('div', { class: 'banner warn' },
      h('b', { text: 'ホーム画面に追加してから使ってください。' }),
      h('div', { text: 'Safariのまま使うと、記録がホーム画面のアプリと別々になったり、消えたりすることがあります。共有ボタン（□↑）→「ホーム画面に追加」を押してください。' })));
  }
  parts.push(h('h1', { class: 'page-h', text: '自分の記録' }), grid);
  if (!books.length) parts.push(h('p', { class: 'hint', text: '「＋ 新しい単元」から、最初の記録ブックを作りましょう。' }));
  const foot = h('div', { class: 'foot-note' }, '記録はこのiPadの中だけに保存されます。ホーム画面のアイコンを消すと、記録も消えます。');
  if (state.teacher) {
    const est = await db.usage();
    const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted().catch(() => null) : null;
    foot.append(h('div', { class: 'teacher-tools' },
      h('button', { class: 'btn', onclick: () => go('#/trash') }, '🗑 ごみ箱'),
      h('span', { text: `保存の守り：${persisted ? 'あり' : persisted === false ? 'なし' : '不明'}` }),
      est ? h('span', { text: `使用量：${(est.usage / 1048576).toFixed(1)}MB` }) : null));
  }
  parts.push(foot);
  fill($view, ...parts);
}

// ---------- 画面：新しい単元 ----------

async function newUnit() {
  setBar({ back: () => go('#/'), title: '新しい単元' });
  const chosen = new Set(RECOMMENDED);
  const name = h('input', { class: 'big-input', placeholder: '例：トマトを育てよう', maxlength: '40' });
  const items = h('div', { class: 'kind-grid' });
  const next = h('button', { class: 'btn primary huge', onclick: create }, 'つぎへ（ならべ方を見る） →');
  const drawItems = () => {
    fill(items, ...KINDS.map((k) => h('button', {
      class: `kind${chosen.has(k.kind) ? ' on' : ''}${k.teacher ? ' teacher' : ''}`,
      'aria-pressed': chosen.has(k.kind) ? 'true' : 'false',
      onclick: () => { chosen.has(k.kind) ? chosen.delete(k.kind) : chosen.add(k.kind); drawItems(); },
    }, h('span', { class: 'kind-icon', text: k.icon }), h('span', { text: k.label }), h('span', { class: 'check', text: chosen.has(k.kind) ? '✓' : '' }))));
  };
  drawItems();
  async function create() {
    const title = name.value.trim();
    if (!title) { toast('単元の名前を書いてください'); name.focus(); return; }
    if (!chosen.size) { toast('項目を1つ以上えらんでください'); return; }
    const layout = autoLayout(KINDS.map((k) => k.kind).filter((k) => chosen.has(k)));
    if (!layout) { toast('項目が多すぎて、A4一枚に入りません。いくつか外してください'); return; }
    await saveNew(title, layout, []);
  }
  async function saveNew(title, layout, goalChoices) {
    const now = new Date().toISOString();
    const book = { id: db.newId(), title, createdAt: now, updatedAt: now, template: layout, goalChoices };
    try {
      await db.put('books', book);
    } catch (e) {
      toast('単元を保存できませんでした。もう一度ためしてください');
      return;
    }
    go(`#/layout/book/${book.id}/start`);
  }
  // ほかの単元の様式（項目・配置・目標の書き方・数える項目・目標の候補）をコピーして始める
  const others = (await db.liveBooks()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const copyPanel = others.length ? h('section', { class: 'panel' },
    h('h2', { text: '③ または、前に作った単元の様式をコピーする' }),
    h('p', { class: 'hint', text: '項目・配置・目標の書き方・数える項目・目標の候補が、そのままコピーされます。記録の中身はコピーされません。' }),
    h('div', { class: 'row' }, ...others.map((o) => h('button', { class: 'btn', onclick: () => {
      const title = name.value.trim();
      if (!title) { toast('先に、単元の名前を書いてください'); name.focus(); return; }
      saveNew(title, cloneLayout(o.template), [...(o.goalChoices || [])]);
    } }, `📘 ${o.title}`)))) : null;
  fill($view, 
    h('section', { class: 'panel' }, h('h2', { text: '① 単元の名前' }), name),
    h('section', { class: 'panel' }, h('h2', { text: '② シートにのせる項目をえらぶ' }),
      h('p', { class: 'hint', text: 'おすすめの項目に、はじめからチェックが付いています。押すと付けたり外したりできます。' }), items),
    h('div', { class: 'center' }, next),
    copyPanel);
  setTimeout(() => name.focus(), 50);
}

// ---------- 画面：単元の記録一覧 ----------

async function bookView(bookId) {
  const book = await db.get('books', bookId);
  if (!book || book.deletedAt) return go('#/');
  const sheets = await db.sheetsOf(bookId);
  setBar({ back: () => go('#/'), title: book.title });

  const actions = h('div', { class: 'book-actions' },
    h('button', { class: 'btn primary huge', onclick: () => nextSheet(book) }, '＋ つぎの記録をつくる'),
    h('button', { class: 'btn huge', disabled: !sheets.length, onclick: () => go(`#/review/${bookId}/${sheets[sheets.length - 1].id}`) }, '📖 ふりかえる'));
  const tools = state.teacher ? h('div', { class: 'teacher-tools' },
    h('button', { class: 'btn', onclick: () => go(`#/layout/book/${bookId}`) }, '🧩 様式を変える'),
    book.template.blocks.some((b) => b.kind === 'goal') ? h('button', { class: 'btn', onclick: () => editGoalChoices(book) }, '🎯 目標の候補') : null,
    h('button', { class: 'btn', onclick: async () => {
      const t = await promptBox('単元の名前を変える', book.title);
      if (t) { book.title = t; book.updatedAt = new Date().toISOString(); await db.put('books', book); route(); }
    } }, '✏️ 単元名を変える'),
    h('button', { class: 'btn danger', onclick: async () => {
      if (!(await confirmBox('この単元をごみ箱へ', `「${book.title}」をごみ箱に入れます。ごみ箱から元にもどせます。`, 'ごみ箱へ'))) return;
      book.deletedAt = new Date().toISOString();
      await db.put('books', book);
      go('#/');
    } }, '🗑 単元をごみ箱へ')) : null;

  const list = h('div', { class: 'cards pages' });
  for (const s of [...sheets].reverse()) {
    const thumb = await thumbOf(s);
    list.append(h('button', { class: 'card page-card', onclick: () => go(`#/review/${bookId}/${s.id}`) },
      h('div', { class: 'cover' }, thumb ? h('img', { src: thumb, alt: '' }) : h('span', { text: '📄' })),
      h('div', { class: 'card-title', text: `${s.no}まいめ　${sheetTitle(s)}` }),
      h('div', { class: 'card-sub', text: formatDate(sheetDate(s)) }),
      goalLine(s) ? h('div', { class: 'card-goal', text: `🎯 ${goalLine(s)}` }) : null,
      countsLine(s) ? h('div', { class: 'card-goal', text: `🔢 ${countsLine(s)}` }) : null));
  }
  fill($view, actions, tools || '',
    h('h2', { class: 'page-h', text: `ページ（${sheets.length}まい）` }),
    sheets.length ? list : h('p', { class: 'hint', text: 'まだページがありません。「つぎの記録をつくる」から始めましょう。' }));
}

function countsLine(sheet) {
  const cb = sheet.layout.blocks.find((b) => b.kind === 'counts');
  return cb ? countsText(cb, sheet.values[cb.id]) : '';
}

function goalLine(sheet) {
  const gb = sheet.layout.blocks.find((b) => b.kind === 'goal');
  return gb ? goalText(gb, sheet.values[gb.id]) : '';
}

// 先生が「目標の候補」を登録する（単元ごと）。児童生徒は入力のときに押して選べる
function editGoalChoices(book) {
  book.goalChoices = book.goalChoices || [];
  const list = h('div');
  const input = h('input', { class: 'big-input', placeholder: '例：なわとびを10回とぶ', maxlength: '60' });
  const persist = async () => {
    book.updatedAt = new Date().toISOString();
    try { await db.put('books', book); } catch (e) { toast('候補を保存できませんでした。もう一度ためしてください'); }
  };
  const draw = () => fill(list, ...(book.goalChoices.length ? book.goalChoices.map((c, i) => h('div', { class: 'cand-edit' },
    h('span', { text: c }),
    h('button', { class: 'btn small', disabled: i === 0, 'aria-label': '上へ', onclick: () => { const a = book.goalChoices; [a[i - 1], a[i]] = [a[i], a[i - 1]]; persist(); draw(); } }, '↑'),
    h('button', { class: 'btn small danger', onclick: () => { book.goalChoices.splice(i, 1); persist(); draw(); } }, '✕ けす'))) : [h('p', { class: 'hint', text: 'まだ候補がありません。' })]));
  const add = () => {
    const t = input.value.trim();
    if (!t) return;
    if (!book.goalChoices.includes(t)) book.goalChoices.push(t);
    input.value = '';
    persist();
    draw();
    input.focus();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  draw();
  modal({
    title: '🎯 目標の候補', wide: true,
    body: h('div', {}, h('p', { class: 'hint', text: 'ここに登録した目標は、記録を書くときに押して選べます（この単元だけ）。' }),
      list, h('div', { class: 'row' }, input, h('button', { class: 'btn primary', onclick: add }, '＋ 足す'))),
    buttons: [{ label: 'できた ✓', cls: 'primary', onClick: () => route() }],
  });
}

// opts.skipLayoutAsk：様式の画面から来たときは、もう聞かない
async function nextSheet(book, { skipLayoutAsk = false } = {}) {
  // 先生モードのときだけ聞く（児童生徒はいつもの手順のまま、すぐ作れる）
  if (state.teacher && !skipLayoutAsk) {
    modal({
      title: 'どの様式で記録をつくりますか？',
      body: h('div', {},
        h('p', { text: '様式を変えると、このページから先に使われます。前に作ったページは変わりません。' })),
      buttons: [
        { label: 'やめる' },
        { label: '🧩 様式を変えてからつくる', onClick: () => go(`#/layout/book/${book.id}/next`) },
        { label: '今の様式でつくる', cls: 'primary', onClick: () => nextSheet(book, { skipLayoutAsk: true }) },
      ],
    });
    return;
  }
  const sheets = await db.sheetsOf(book.id);
  const prev = sheets[sheets.length - 1];
  const opts = carryOptions(book.template, prev && prev.values);
  const make = async (carry) => {
    const values = {};
    for (const b of book.template.blocks) if (b.kind === 'date') values[b.id] = { text: todayISO() };
    const goal = book.template.blocks.find((b) => b.kind === 'goal');
    if (carry && goal) values[goal.id] = { ...carry };
    const now = new Date().toISOString();
    const all = await db.sheetsOf(book.id, { withDeleted: true });
    const sheet = {
      id: db.newId(), bookId: book.id, no: all.reduce((m, s) => Math.max(m, s.no), 0) + 1,
      createdAt: now, updatedAt: now, layout: cloneLayout(book.template), values,
    };
    try {
      await db.put('sheets', sheet);
      await touchBook(book.id);
    } catch (e) {
      toast('ページを作れませんでした（保存できませんでした）。もう一度ためしてください');
      return;
    }
    go(`#/sheet/${sheet.id}`);
  };
  if (!opts.length) return make(null);
  modal({
    title: '前回の目標を使いますか？',
    body: h('div', {}, ...opts.map((o) => h('div', { class: 'carry' }, h('div', { class: 'carry-l', text: o.label }), h('div', { class: 'carry-t', text: o.text })))),
    buttons: [...opts.map((o) => ({ label: o.id === 'goal' ? '前回の目標を使う' : '「次回に向けて」を使う', cls: 'primary', onClick: () => make(o.value) })),
      { label: '使わない', onClick: () => make(null) }],
  });
}

// ---------- 画面：記録入力 ----------

async function sheetView(sheetId) {
  const sheet = await db.get('sheets', sheetId);
  if (!sheet || sheet.deletedAt) return go('#/');
  const book = await db.get('books', sheet.bookId);
  await loadPhotos(sheetId);
  const prevSheet = (await db.sheetsOf(sheet.bookId)).filter((s) => s.no < sheet.no).pop() || null;

  const undo = []; // 変更する「前」の中身を積む
  const busy = new Set(); // 保存中の写真
  const saver = screenSaver(async () => {
    sheet.updatedAt = new Date().toISOString();
    await db.put('sheets', sheet);
    await touchBook(sheet.bookId);
  }, { afterLeave: () => cleanupPhotos(sheet), busy });
  // 書いたらすぐ保存（0.15秒だけまとめる）。now なら待たずに保存し、結果（true/false）を返す
  const changed = (now = false) => saver.changed(now);
  // 変更の直前に呼ぶ。同じ中身は積まない
  function pushUndo() {
    const snap = JSON.stringify(sheet.values);
    if (undo[undo.length - 1] === snap) return;
    undo.push(snap);
    if (undo.length > 20) undo.shift();
    undoBtn.disabled = false;
  }

  const undoBtn = h('button', { class: 'btn', disabled: true, onclick: () => {
    const now = JSON.stringify(sheet.values);
    let snap = undo.pop();
    while (snap === now && undo.length) snap = undo.pop();
    undoBtn.disabled = !undo.length;
    if (!snap || snap === now) return;
    sheet.values = JSON.parse(snap);
    changed(true);
    draw();
    toast('ひとつ前にもどしました');
  } }, '↶ もどす');

  const actions = [undoBtn, h('button', { class: 'btn', onclick: () => go(`#/print/${sheetId}`) }, '🖨 印刷')];
  if (state.teacher) {
    actions.push(h('button', { class: 'btn', onclick: () => go(`#/layout/sheet/${sheetId}`) }, '🧩 配置'));
    actions.push(h('button', { class: 'btn danger', onclick: async () => {
      if (!(await confirmBox('このページをごみ箱へ', `${sheet.no}まいめをごみ箱に入れます。ごみ箱から元にもどせます。`, 'ごみ箱へ'))) return;
      sheet.deletedAt = new Date().toISOString();
      if (!(await changed(true))) { delete sheet.deletedAt; toast('保存できなかったので、ごみ箱に入れていません'); return; }
      go(`#/book/${sheet.bookId}`);
    } }, '🗑'));
  }
  setBar({ back: () => go(`#/book/${sheet.bookId}`), title: `${book.title}　${sheet.no}まいめ`, actions, save: true });
  setSave('saved');

  const notice = h('div', { class: 'banner warn hidden' });
  const holder = h('div', { class: 'sheet-holder' });
  fill($view, h('p', { class: 'hint center', text: '書きたい欄を押してください。書いたものは自動で保存されます。' }), notice, holder);

  function draw() {
    const s = buildSheet({ unitTitle: book.title, no: sheet.no, layout: sheet.layout, values: sheet.values, photoURL: (id) => state.photoURL.get(id), mode: 'input' });
    const w = Math.min(holder.clientWidth || $view.clientWidth, 900);
    fill(holder, fitBox(s, w));
    s.addEventListener('click', (e) => {
      const blk = e.target.closest('.blk');
      if (blk) openEditor(blk.dataset.id);
    });
    const over = markOverflow(s);
    notice.classList.toggle('hidden', !over);
    notice.textContent = over ? `赤い枠の欄（${over}つ）は、文が入りきっていません。印刷すると切れてしまいます。文を短くするか、先生と配置を変えましょう。` : '';
  }

  function openEditor(id) {
    const b = sheet.layout.blocks.find((x) => x.id === id);
    if (!b) return;
    const info = kindInfo(b.kind);
    if (info.teacher && !state.teacher) {
      toast('「先生より」の欄は、先生モードのときに書けます');
      return;
    }
    const v = sheet.values[id] || (sheet.values[id] = {});
    // 書き始め（1.5秒あいてから打った最初の1文字）の前の中身を、もどす先にする
    let typingTimer = null;
    const onType = (text) => {
      if (typingTimer) clearTimeout(typingTimer); else pushUndo();
      typingTimer = setTimeout(() => { typingTimer = null; }, 1500);
      v.text = text;
      changed();
    };
    const body = h('div', { class: 'editor' });

    // 数を入れる1行（「−」「＋」ボタンつき）。prev は前回の数の表示
    const numRow = (label, unit, obj, key, prev) => {
      const inp = h('input', { class: 'num-input', type: 'number', inputmode: 'numeric', min: '0', 'aria-label': label });
      inp.value = obj[key] ?? '';
      const set = (n) => {
        pushUndo();
        obj[key] = n === '' ? '' : Math.max(0, Number(n));
        inp.value = obj[key];
        changed();
      };
      inp.addEventListener('change', () => set(inp.value));
      const step = (d) => set(String(Math.max(0, (Number(inp.value) || 0) + d)));
      return h('div', { class: 'num-row' },
        h('span', { class: 'num-label', text: label }),
        h('button', { class: 'btn', 'aria-label': '1へらす', onclick: () => step(-1) }, '−'),
        inp,
        h('button', { class: 'btn', 'aria-label': '1ふやす', onclick: () => step(1) }, '＋'),
        h('span', { class: 'unit', text: unit || '' }),
        prev ? h('span', { class: 'prev', text: prev }) : null);
    };

    if (b.kind === 'goal') {
      const mode = b.goalMode || 'text';
      if (mode !== 'number') {
        const ta = h('textarea', { class: 'big-text', rows: '3', placeholder: 'ここに書く', oninput: (e) => onType(e.target.value) });
        ta.value = v.text || '';
        const cands = book.goalChoices || [];
        if (cands.length) {
          const row = h('div', { class: 'cand-row' });
          const drawC = () => fill(row, ...cands.map((c) => h('button', { class: `cand${(v.text || '') === c ? ' on' : ''}`, onclick: () => {
            pushUndo();
            v.text = c;
            ta.value = c;
            changed();
            drawC();
          } }, c)));
          drawC();
          body.append(h('p', { class: 'hint', text: '先生が用意した目標から、押してえらべます。自分で書いてもいいです。' }), row);
        }
        body.append(ta);
      }
      if (mode !== 'text') body.append(numRow('🎯 目標', b.unit, v, 'num'));
      if (b.showResult) body.append(numRow('できた', b.unit, v, 'result'));
    } else if (b.kind === 'counts') {
      const rows = b.rows || [];
      v.nums = v.nums || {};
      const prevNums = (prevSheet && prevSheet.values[b.id] && prevSheet.values[b.id].nums) || {};
      if (!rows.length) {
        body.append(h('p', { class: 'hint', text: 'まだ数える項目がありません。先生が「🧩 配置」（このページ）か、単元の「🧩 様式を変える」で項目を足します。' }));
      } else {
        body.append(h('p', { class: 'hint', text: '数を入れてください。「−」「＋」でも変えられます。' }));
      }
      for (const r of rows) {
        body.append(numRow(r.label, r.unit, v.nums, r.id, hasNum(prevNums[r.id]) ? `前回 ${prevNums[r.id]}${r.unit || ''}` : null));
      }
    } else if (info.type === 'date') {
      const d = h('input', { type: 'date', class: 'big-input', value: v.text || todayISO(), oninput: (e) => { pushUndo(); v.text = e.target.value; changed(); } });
      if (!v.text) { v.text = d.value; changed(); }
      body.append(d, h('button', { class: 'btn', onclick: () => { pushUndo(); d.value = todayISO(); v.text = d.value; changed(); } }, '今日にする'));
    } else if (info.type === 'photo') {
      const max = b.photoCount || 1;
      const shown = h('div', { class: 'photo-list' });
      const drawPhotos = () => {
        const ids = v.photoIds || [];
        fill(shown, ...(ids.length ? ids.slice(0, max).map((pid, i) => h('div', { class: 'photo-item' },
          h('img', { src: state.photoURL.get(pid) || '', alt: '写真' }),
          h('button', { class: 'btn small', onclick: () => {
            pushUndo();
            v.photoIds = ids.filter((_, j) => j !== i);
            changed(true);
            drawPhotos();
          } }, '✕ はずす'))) : [h('p', { class: 'hint', text: 'まだ写真がありません' })]));
      };
      // slot：入れかえる写真の番号（null なら後ろに足す）
      const pick = (capture, slot = null) => {
        const ids0 = (v.photoIds || []).slice(0, max);
        if (slot === null && ids0.length >= max) {
          if (max === 1) return pick(capture, 0);
          // いっぱいのときは、どれと入れかえるか選んでもらう
          const close = modal({
            title: 'どの写真と入れかえますか？',
            body: h('div', { class: 'photo-list' }, ...ids0.map((pid, i) => h('button', { class: 'photo-pick', onclick: () => { close(); pick(capture, i); } },
              h('img', { src: state.photoURL.get(pid) || '', alt: `${i + 1}まいめの写真` }), h('span', { text: `${i + 1}まいめと入れかえる` })))),
            buttons: [{ label: 'やめる' }],
          });
          return;
        }
        const inp = h('input', { type: 'file', accept: 'image/*', class: 'hidden' });
        if (capture) inp.setAttribute('capture', 'environment');
        inp.addEventListener('change', () => {
          const f = inp.files && inp.files[0];
          inp.remove();
          if (!f) return;
          const job = addPhoto(f);
          busy.add(job);
          job.finally(() => busy.delete(job));
        });
        const addPhoto = async (f) => {
          setSave('saving');
          try {
            const p = await shrinkPhoto(f);
            const rec = { id: db.newId(), sheetId, blob: p.blob, thumb: p.thumb, width: p.width, height: p.height, createdAt: new Date().toISOString() };
            await db.put('photos', rec); // 先に写真を保存してから、ページに付ける
            state.photoURL.set(rec.id, URL.createObjectURL(rec.blob));
            state.thumbURL.set(rec.id, URL.createObjectURL(rec.thumb));
            pushUndo();
            const ids = (v.photoIds || []).slice(0, max);
            if (slot !== null && slot < ids.length) ids[slot] = rec.id; else ids.push(rec.id);
            v.photoIds = ids;
            if (!(await changed(true))) toast('保存できませんでした。もう一度ためしています');
            drawPhotos();
          } catch (e) {
            setSave('error');
            toast(e.message || '写真を保存できませんでした');
          }
        };
        document.body.append(inp);
        inp.click();
      };
      drawPhotos();
      body.append(shown, h('div', { class: 'row' },
        h('button', { class: 'btn primary huge', onclick: () => pick(true) }, '📷 カメラでとる'),
        h('button', { class: 'btn huge', onclick: () => pick(false) }, '🖼 写真をえらぶ')),
      h('p', { class: 'hint', text: max > 1 ? `写真は${max}まいまで。いっぱいのときは、どの写真と入れかえるか選べます。` : 'もう一度とると、写真が入れかわります。「もどす」で前の写真にもどせます。' }));
    } else {
      if (info.type === 'choice') {
        const chips = h('div', { class: 'choice-row' });
        const drawChips = () => fill(chips, ...FEELING_CHOICES.map((c) => {
          const on = (v.choices || []).includes(c);
          return h('button', { class: `choice${on ? ' on' : ''}`, 'aria-pressed': on ? 'true' : 'false', onclick: () => {
            pushUndo();
            v.choices = on ? v.choices.filter((x) => x !== c) : [...(v.choices || []), c];
            changed();
            drawChips();
          } }, on ? `✓ ${c}` : c);
        }));
        drawChips();
        body.append(h('p', { class: 'hint', text: 'あてはまるものを押してください（いくつでも）。文で書いてもいいです。' }), chips);
      }
      const ta = h('textarea', { class: 'big-text', rows: info.type === 'choice' ? '4' : '7', placeholder: 'ここに書く', oninput: (e) => onType(e.target.value) });
      ta.value = v.text || '';
      body.append(ta);
      if (info.type !== 'choice') setTimeout(() => ta.focus(), 80);
    }

    modal({
      title: `${info.icon} ${b.label}`, body, wide: true,
      buttons: [{ label: 'とじる ✓', cls: 'primary', onClick: () => { saver.flush(); draw(); } }],
    });
  }

  draw();
}

// ---------- 画面：様式調整 ----------

// mode：'start'（新しい単元を作った直後）／'next'（つぎの記録をつくる前に様式を変える）
async function layoutView(target, id, mode) {
  const start = mode === 'start';
  let book;
  let sheet = null;
  if (target === 'sheet') {
    sheet = await db.get('sheets', id);
    if (!sheet) return go('#/');
    book = await db.get('books', sheet.bookId);
    await loadPhotos(id);
  } else {
    book = await db.get('books', id);
  }
  if (!book) return go('#/');
  // 既存の単元の様式変更は先生モードだけ（新しい単元を作った直後はだれでも）
  if (!start && !state.teacher) {
    toast('様式を変えるのは先生モードのときです');
    return go(sheet ? `#/sheet/${sheet.id}` : `#/book/${book.id}`);
  }
  const layout = sheet ? sheet.layout : book.template;
  let selected = layout.blocks[0] ? layout.blocks[0].id : null;

  const saver = screenSaver(async () => {
    if (sheet) { sheet.updatedAt = new Date().toISOString(); await db.put('sheets', sheet); }
    else { book.updatedAt = new Date().toISOString(); await db.put('books', book); }
  });
  const save = () => saver.changed();
  const startBtn = h('button', { class: 'btn primary', onclick: async () => {
    if (!(await saver.flush())) { toast('保存できませんでした。もう一度押してください'); return; }
    if (start || mode === 'next') return nextSheet(book, { skipLayoutAsk: true });
    go(sheet ? `#/sheet/${sheet.id}` : `#/book/${book.id}`);
  } }, start ? 'この様式で始める →' : mode === 'next' ? 'この様式で記録をつくる →' : 'できた ✓');
  setBar({
    back: () => go(sheet ? `#/sheet/${sheet.id}` : `#/book/${book.id}`),
    title: sheet ? `${sheet.no}まいめの配置` : `「${book.title}」の様式`,
    actions: [startBtn],
    save: true,
  });
  setSave('saved');

  const holder = h('div', { class: 'sheet-holder layout' });
  const tools = h('div', { class: 'layout-tools' });
  const note = sheet ? 'このページだけの配置です。ほかのページは変わりません。'
    : 'ここで決めた様式は、これから作るページに使われます。前に作ったページは変わりません。';
  fill($view, 
    h('p', { class: 'hint center', text: `${note} 欄を長押しすると動かせます。右下の丸で大きさを変えます。` }),
    h('div', { class: 'layout-wrap' }, holder, tools));

  function tryChange(b, patch) {
    const c = { ...b, ...patch };
    if (!canPlace(layout.blocks, c)) { toast('ほかの欄と重なるか、シートからはみ出します'); return false; }
    Object.assign(b, patch);
    save();
    draw();
    return true;
  }

  function drawTools() {
    const b = layout.blocks.find((x) => x.id === selected);
    const used = new Set(layout.blocks.map((x) => x.kind));
    const addable = KINDS.filter((k) => !used.has(k.kind));
    const addBtn = h('button', { class: 'btn', disabled: !addable.length, onclick: () => {
      const close = modal({ title: '欄を足す', body: h('div', { class: 'kind-grid' }, ...addable.map((k) => h('button', { class: 'kind', onclick: () => {
        close();
        const next = addBlock(layout, k.kind);
        if (!next) { toast('空いている場所がありません。ほかの欄を小さくしてください'); return; }
        layout.blocks = next.blocks;
        selected = k.kind;
        save();
        draw();
      } }, h('span', { class: 'kind-icon', text: k.icon }), h('span', { text: k.label })))), buttons: [{ label: 'やめる' }] });
    } }, '＋ 欄を足す');
    if (!b) { fill(tools, addBtn); return; }
    const mv = (dx, dy) => tryChange(b, { x: b.x + dx, y: b.y + dy });
    const rs = (dw, dh) => tryChange(b, { w: b.w + dw, h: b.h + dh });
    fill(tools, 
      h('div', { class: 'tool-title', text: `えらんでいる欄：${b.label}` }),
      h('div', { class: 'tool-group' }, h('span', { text: '動かす' }),
        h('div', { class: 'pad' },
          h('button', { class: 'btn', onclick: () => mv(0, -1), 'aria-label': '上へ' }, '↑'),
          h('button', { class: 'btn', onclick: () => mv(-1, 0), 'aria-label': '左へ' }, '←'),
          h('button', { class: 'btn', onclick: () => mv(1, 0), 'aria-label': '右へ' }, '→'),
          h('button', { class: 'btn', onclick: () => mv(0, 1), 'aria-label': '下へ' }, '↓'))),
      h('div', { class: 'tool-group' }, h('span', { text: '大きさ' }),
        h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: () => rs(1, 0) }, '横に広げる'),
          h('button', { class: 'btn', onclick: () => rs(-1, 0) }, '横をせばめる')),
        h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: () => rs(0, 1) }, '縦に広げる'),
          h('button', { class: 'btn', onclick: () => rs(0, -1) }, '縦をせばめる'))),
      b.kind === 'photo'
        ? h('div', { class: 'tool-group' }, h('span', { text: '写真の数' }), h('div', { class: 'row' },
          ...[1, 2].map((n) => h('button', { class: `btn${(b.photoCount || 1) === n ? ' on' : ''}`, onclick: () => { b.photoCount = n; save(); draw(); } }, `${n}まい`))))
        : h('div', { class: 'tool-group' }, h('span', { text: '文字の大きさ' }), h('div', { class: 'row' },
          ...[['s', '小'], ['m', '中'], ['l', '大']].map(([k, l]) => h('button', { class: `btn${(b.size || 'm') === k ? ' on' : ''}`, onclick: () => { b.size = k; save(); draw(); } }, l)))),
      b.kind === 'goal' ? goalTools(b) : null,
      b.kind === 'counts' ? countsTools(b) : null,
      h('div', { class: 'row' },
        h('button', { class: 'btn danger', onclick: () => {
          layout.blocks = layout.blocks.filter((x) => x.id !== b.id);
          selected = layout.blocks[0] ? layout.blocks[0].id : null;
          save();
          draw();
          toast(sheet ? '欄を外しました（書いた内容は消えていません。欄を足すと出てきます）' : '欄を外しました');
        } }, 'この欄を外す'),
        addBtn));
  }

  // 「数の記録」で数える項目（例：葉の数・赤い実の数）
  function countsTools(b) {
    const rows = b.rows || (b.rows = []);
    const label = h('input', { class: 'label-input', placeholder: '例：赤い実の数', maxlength: '20', 'aria-label': '数える項目の名前' });
    const unit = h('input', { class: 'unit-input', value: 'こ', maxlength: '8', 'aria-label': '単位' });
    const add = () => {
      const t = label.value.trim();
      if (!t) { toast('数える項目の名前を書いてください'); label.focus(); return; }
      rows.push(newCountRow(t, unit.value.trim()));
      save();
      draw();
      toast(`「${t}」を足しました`);
    };
    label.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    return h('div', { class: 'tool-group' },
      h('span', { text: '数える項目' }),
      ...(rows.length ? rows.map((r, i) => h('div', { class: 'row-edit' },
        h('span', { class: 'name', text: `${r.label}（${r.unit || '単位なし'}）` }),
        h('button', { class: 'btn', disabled: i === 0, 'aria-label': '上へ', onclick: () => { [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]]; save(); draw(); } }, '↑'),
        h('button', { class: 'btn danger', 'aria-label': 'けす', onclick: () => { rows.splice(i, 1); save(); draw(); } }, '✕'))) : [h('div', { class: 'hint', text: 'まだありません。下で足してください。' })]),
      h('div', { class: 'row-edit' }, label, unit),
      h('div', { class: 'row' }, ...GOAL_UNITS.map((u) => h('button', { class: 'btn small', onclick: () => { unit.value = u; } }, u))),
      h('button', { class: 'btn primary', onclick: add }, '＋ 項目を足す'),
      h('div', { class: 'hint', text: sheet ? 'このページだけに使われます。' : 'これから作るページに使われます。前のページは変わりません。' }));
  }

  // 「今日の目標」の書き方・単位・できた数の欄・候補
  function goalTools(b) {
    const mode = b.goalMode || 'text';
    const set = (patch) => { Object.assign(b, patch); save(); draw(); };
    const unitIn = h('input', { class: 'unit-input', value: b.unit || '', maxlength: '8', 'aria-label': '単位' });
    unitIn.addEventListener('change', () => set({ unit: unitIn.value.trim() }));
    return h('div', { class: 'tool-group' },
      h('span', { text: '目標の書き方' }),
      h('div', { class: 'row' }, ...GOAL_MODES.map(([k, l]) => h('button', { class: `btn${mode === k ? ' on' : ''}`, onclick: () => set({ goalMode: k }) }, l))),
      mode !== 'text' || b.showResult ? h('div', {},
        h('span', { text: '単位' }),
        h('div', { class: 'row' }, ...GOAL_UNITS.map((u) => h('button', { class: `btn small${b.unit === u ? ' on' : ''}`, onclick: () => set({ unit: u }) }, u)), unitIn)) : null,
      h('span', { text: 'できた数の欄' }),
      h('div', { class: 'row' },
        h('button', { class: `btn${!b.showResult ? ' on' : ''}`, onclick: () => set({ showResult: false }) }, 'なし'),
        h('button', { class: `btn${b.showResult ? ' on' : ''}`, onclick: () => set({ showResult: true }) }, 'あり')),
      h('button', { class: 'btn', onclick: () => editGoalChoices(book) }, '🎯 目標の候補'));
  }

  function draw() {
    const s = buildSheet({ unitTitle: book.title, no: sheet && sheet.no, layout, values: sheet ? sheet.values : {}, photoURL: (pid) => state.photoURL.get(pid), mode: 'layout', showValues: !!sheet, selectedId: selected });
    const avail = holder.clientWidth || 600;
    const maxH = window.innerHeight - 150;
    fill(holder, fitBox(s, avail, maxH));
    if (sheet) markOverflow(s);
    wireDrag(s);
    drawTools();
  }

  // 長押しで持ち上げて動かす／右下の丸で大きさを変える
  function wireDrag(s) {
    const grid = s.querySelector('.sheet-grid');
    for (const node of s.querySelectorAll('.blk')) {
      const b = layout.blocks.find((x) => x.id === node.dataset.id);
      let mode = null;
      let sx = 0;
      let sy = 0;
      let lift = null;
      let cand = null;
      const cell = () => { const r = grid.getBoundingClientRect(); return { cw: r.width / COLS, ch: r.height / ROWS }; };
      const begin = (e, m) => {
        mode = m;
        sx = e.clientX;
        sy = e.clientY;
        cand = { ...b };
        node.classList.add('lifting');
        try { node.setPointerCapture(e.pointerId); } catch { /* 古い端末 */ }
      };
      node.addEventListener('pointerdown', (e) => {
        if (selected !== b.id) { selected = b.id; s.querySelectorAll('.blk.selected').forEach((x) => x.classList.remove('selected')); node.classList.add('selected'); drawTools(); }
        if (e.target.classList.contains('grip')) { e.preventDefault(); begin(e, 'resize'); return; }
        sx = e.clientX;
        sy = e.clientY;
        lift = setTimeout(() => { lift = null; begin(e, 'move'); }, 350);
      });
      node.addEventListener('pointermove', (e) => {
        if (lift && (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10)) { clearTimeout(lift); lift = null; }
        if (!mode) return;
        const { cw, ch } = cell();
        const dc = Math.round((e.clientX - sx) / cw);
        const dr = Math.round((e.clientY - sy) / ch);
        cand = mode === 'move' ? { ...b, x: b.x + dc, y: b.y + dr } : { ...b, w: Math.max(1, b.w + dc), h: Math.max(1, b.h + dr) };
        const ok = canPlace(layout.blocks, cand);
        node.classList.toggle('blocked', !ok);
        node.style.gridColumn = `${Math.max(0, Math.min(cand.x, COLS - 1)) + 1} / span ${Math.max(1, Math.min(cand.w, COLS))}`;
        node.style.gridRow = `${Math.max(0, Math.min(cand.y, ROWS - 1)) + 1} / span ${Math.max(1, Math.min(cand.h, ROWS))}`;
      });
      const end = () => {
        if (lift) { clearTimeout(lift); lift = null; }
        if (!mode) return;
        mode = null;
        node.classList.remove('lifting');
        if (cand && canPlace(layout.blocks, cand) && (cand.x !== b.x || cand.y !== b.y || cand.w !== b.w || cand.h !== b.h)) {
          Object.assign(b, { x: cand.x, y: cand.y, w: cand.w, h: cand.h });
          save();
        } else if (cand && !canPlace(layout.blocks, cand)) {
          toast('そこには置けません（重なるか、はみ出します）');
        }
        draw();
      };
      node.addEventListener('pointerup', end);
      node.addEventListener('pointercancel', end);
    }
  }

  draw();
}

// ---------- 画面：振り返り ----------

async function reviewView(bookId, sheetId) {
  const book = await db.get('books', bookId);
  const sheets = await db.sheetsOf(bookId);
  if (!book || !sheets.length) return go(`#/book/${bookId}`);
  let i = sheets.findIndex((s) => s.id === sheetId);
  if (i < 0) i = sheets.length - 1;
  const sheet = sheets[i];
  await loadPhotos(sheet.id);

  const goto = (j) => { if (j >= 0 && j < sheets.length) location.replace(`#/review/${bookId}/${sheets[j].id}`); };
  setBar({
    back: () => go(`#/book/${bookId}`), title: `${book.title}　ふりかえり`,
    actions: [h('button', { class: 'btn', onclick: () => go(`#/print/${sheet.id}`) }, '🖨 印刷')],
  });

  const stage = h('div', { class: 'review-stage' });
  const prev = h('button', { class: 'btn flip', disabled: i === 0, onclick: () => goto(i - 1), 'aria-label': '前のページ' }, '◀');
  const next = h('button', { class: 'btn flip', disabled: i === sheets.length - 1, onclick: () => goto(i + 1), 'aria-label': '次のページ' }, '▶');
  const strip = h('div', { class: 'strip' });
  for (const [j, s] of sheets.entries()) {
    const t = await thumbOf(s);
    strip.append(h('button', { class: `strip-item${j === i ? ' on' : ''}`, onclick: () => goto(j) },
      t ? h('img', { src: t, alt: '' }) : h('span', { text: '📄' }), h('span', { text: `${s.no}` })));
  }
  fill($view, 
    h('div', { class: 'review' }, prev, stage, next),
    h('div', { class: 'review-foot' },
      h('div', { class: 'page-count', text: `${i + 1} / ${sheets.length}` }),
      h('button', { class: 'btn primary', onclick: () => go(`#/sheet/${sheet.id}`) }, `✏️ ${sheet.no}まいめに書き足す`)),
    strip);

  const s = buildSheet({ unitTitle: book.title, no: sheet.no, layout: sheet.layout, values: sheet.values, photoURL: (id) => state.photoURL.get(id), mode: 'view' });
  const maxH = window.innerHeight - 260;
  stage.append(fitBox(s, Math.min(stage.clientWidth || 600, 900), Math.max(320, maxH)));
  strip.querySelector('.on')?.scrollIntoView({ inline: 'center', block: 'nearest' });

  // 左右にスワイプしてめくる
  let x0 = null;
  stage.addEventListener('pointerdown', (e) => { x0 = e.clientX; });
  stage.addEventListener('pointerup', (e) => {
    if (x0 == null) return;
    const dx = e.clientX - x0;
    x0 = null;
    if (dx < -60) goto(i + 1);
    else if (dx > 60) goto(i - 1);
  });
}

// ---------- 画面：印刷プレビュー ----------

async function printView(sheetId) {
  const sheet = await db.get('sheets', sheetId);
  if (!sheet) return go('#/');
  const book = await db.get('books', sheet.bookId);
  await loadPhotos(sheetId);
  const make = () => buildSheet({ unitTitle: book.title, no: sheet.no, layout: sheet.layout, values: sheet.values, photoURL: (id) => state.photoURL.get(id), mode: 'view' });

  setBar({ back: () => (history.length > 1 ? history.back() : go(`#/sheet/${sheetId}`)), title: `${sheet.no}まいめを印刷` });
  const holder = h('div', { class: 'sheet-holder' });
  const warn = h('div', { class: 'banner warn hidden' });
  fill($view, 
    h('div', { class: 'center' },
      h('button', { class: 'btn primary huge', onclick: doPrint }, '🖨 印刷する・PDFにする'),
      h('p', { class: 'hint', text: 'iPadの印刷画面が開きます。プリンターをえらぶと印刷できます。PDFにするときは、印刷画面の共有ボタン（□↑）→「\"ファイル\"に保存」をえらびます。' })),
    warn, holder);
  const s = make();
  holder.append(fitBox(s, Math.min(holder.clientWidth || 600, 700)));
  const over = markOverflow(s);
  if (over) {
    warn.classList.remove('hidden');
    fill(warn,
      h('div', { text: `文が入りきっていない欄が${over}つあります。このまま印刷すると、はみ出した文は切れます。` }),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => go(`#/sheet/${sheetId}`) }, '✏️ 入力にもどる'),
        state.teacher
          ? h('button', { class: 'btn', onclick: () => go(`#/layout/sheet/${sheetId}`) }, '🧩 配置を直す')
          : h('span', { class: 'hint', text: '配置を直すときは、先生モードで「🧩 配置」を使います。' })));
  }

  async function doPrint() {
    const real = make();
    fill($print, real);
    await Promise.all([...real.querySelectorAll('img')].map((img) => (img.decode ? img.decode().catch(() => {}) : null)));
    window.print();
  }
}

// ---------- 画面：ごみ箱 ----------

async function trashView() {
  if (!state.teacher) return go('#/');
  setBar({ back: () => go('#/'), title: 'ごみ箱' });
  const books = await db.all('books');
  const sheets = await db.all('sheets');
  const titleOf = (id) => (books.find((b) => b.id === id) || {}).title || '';
  const dBooks = books.filter((b) => b.deletedAt);
  const dSheets = sheets.filter((s) => s.deletedAt && !dBooks.some((b) => b.id === s.bookId));
  const restore = async (store, obj) => { delete obj.deletedAt; await db.put(store, obj); toast('元にもどしました'); route(); };
  const rows = [
    ...dBooks.map((b) => h('div', { class: 'trash-row' }, h('span', { text: `📘 単元「${b.title}」` }), h('button', { class: 'btn primary', onclick: () => restore('books', b) }, 'もとにもどす'))),
    ...dSheets.map((s) => h('div', { class: 'trash-row' }, h('span', { text: `📄 「${titleOf(s.bookId)}」${s.no}まいめ ${sheetTitle(s)}` }), h('button', { class: 'btn primary', onclick: () => restore('sheets', s) }, 'もとにもどす'))),
  ];
  fill($view, 
    h('p', { class: 'hint', text: 'ごみ箱に入れた単元やページは、ここから元にもどせます。' }),
    rows.length ? h('div', { class: 'panel' }, ...rows) : h('p', { class: 'hint', text: 'ごみ箱は空です。' }),
    rows.length ? h('button', { class: 'btn danger', onclick: async () => {
      if (!(await confirmBox('ごみ箱を空にする', 'ごみ箱の中身を完全に消します。消したものは元にもどせません。', '完全に消す'))) return;
      for (const b of dBooks) await db.purgeBook(b.id);
      for (const s of dSheets) await db.purgeSheet(s.id);
      toast('ごみ箱を空にしました');
      route();
    } }, 'ごみ箱を空にする') : null);
}

// ---------- 道案内 ----------

let routing = Promise.resolve();
let currentHash = location.hash;
function route() {
  routing = routing.then(async () => {
    if (state.leave) {
      if ((await state.leave()) === false) {
        // 保存できなかったので、元の画面にとどまる（アドレスだけ元にもどす）
        if (location.hash !== currentHash) history.replaceState(null, '', currentHash || '#/');
        return;
      }
      state.leave = null;
    }
    currentHash = location.hash;
    releaseURLs();
    fill($modal);
    window.scrollTo(0, 0);
    const p = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    try {
      if (!p.length) await home();
      else if (p[0] === 'new') await newUnit();
      else if (p[0] === 'book') await bookView(p[1]);
      else if (p[0] === 'sheet') await sheetView(p[1]);
      else if (p[0] === 'layout') await layoutView(p[1], p[2], p[3]);
      else if (p[0] === 'review') await reviewView(p[1], p[2]);
      else if (p[0] === 'print') await printView(p[1]);
      else if (p[0] === 'trash') await trashView();
      else go('#/');
    } catch (e) {
      console.error(e);
      fill($view, h('div', { class: 'banner warn' }, '画面を開けませんでした。ホームにもどってください。', h('button', { class: 'btn', onclick: () => go('#/') }, 'ホームへ')));
    }
  });
  return routing;
}

window.addEventListener('hashchange', route);
// 思わぬ保存の失敗などを見のがさない
window.addEventListener('unhandledrejection', (e) => { console.error(e.reason); toast('うまく保存・表示できませんでした。もう一度ためしてください'); });
window.addEventListener('afterprint', () => fill($print));
let lastW = window.innerWidth;
window.addEventListener('resize', () => {
  // iPadを縦横に回したときは描き直す（キーボードの出入りによる高さの変化では描き直さない）
  if (Math.abs(window.innerWidth - lastW) > 40 && !$modal.children.length) { lastW = window.innerWidth; route(); }
});

db.askPersist();
// 控えは https の本番だけ（手元の確認では ?sw を付けたときだけ）。開発中に古い版が出ないようにするため
if ('serviceWorker' in navigator && (location.protocol === 'https:' || new URLSearchParams(location.search).has('sw'))) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
route();
