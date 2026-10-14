// 項目の種類と、A4シート（6列×12段のます目）への配置の計算。
// 画面に関係しない計算だけを置く（node --test で確かめられるように）。

export const COLS = 6;
export const ROWS = 12;

export const FEELING_CHOICES = ['楽しかった', '難しかった', 'またやりたい', '自分でできた', '手伝ってもらってできた'];

// 並び順は、項目選択の画面と自動配置の順番を兼ねる
export const KINDS = [
  { kind: 'date', label: '日付', icon: '📅', type: 'date' },
  { kind: 'title', label: 'タイトル', icon: '🏷️', type: 'text' },
  { kind: 'goal', label: '今日の目標', icon: '🎯', type: 'text' },
  { kind: 'photo', label: '写真', icon: '📷', type: 'photo' },
  { kind: 'did', label: '取り組んだこと', icon: '✋', type: 'text' },
  { kind: 'result', label: 'できたこと', icon: '⭐', type: 'text' },
  { kind: 'growth', label: '成長・変化', icon: '🌱', type: 'text' },
  { kind: 'counts', label: '数の記録', icon: '🔢', type: 'counts' },
  { kind: 'feeling', label: '感想', icon: '😊', type: 'choice' },
  { kind: 'next', label: '次回に向けて', icon: '➡️', type: 'text' },
  { kind: 'free', label: '自由記入', icon: '📝', type: 'text' },
  { kind: 'teacher', label: '先生より', icon: '🧑‍🏫', type: 'text', teacher: true },
];

export const RECOMMENDED = ['date', 'title', 'goal', 'photo', 'did', 'feeling', 'next'];

// 「今日の目標」の書き方：文字だけ／数字だけ／文字＋数字（先生が様式で決める）
export const GOAL_MODES = [['text', '文字'], ['number', '数字'], ['both', '文字＋数字']];
export const GOAL_UNITS = ['回', 'まい', 'こ', '分', '秒', 'cm', 'm', 'ページ'];

export function kindInfo(kind) {
  return KINDS.find((k) => k.kind === kind);
}

// 写真のとなりに置く文章の欄の候補（この順で1つ選ぶ）
const SIDE_TEXT = ['did', 'result', 'growth', 'next', 'free'];

function newBlock(kind, x, y, w, h) {
  const info = kindInfo(kind);
  const b = { id: kind, kind, label: info.label, x, y, w, h, size: 'm' };
  if (kind === 'photo') b.photoCount = 1;
  if (kind === 'goal') Object.assign(b, { goalMode: 'text', unit: '回', showResult: false });
  // 数の記録：数える項目（例：葉の数・赤い実の数）は先生が足す
  if (kind === 'counts') b.rows = [];
  if (kind === 'title') b.size = 'l';
  return b;
}

// 選んだ項目を上から詰めて置く。textH は文章欄の高さ（2→入らなければ1）
function place(kinds, textH) {
  const set = new Set(kinds);
  const has = (k) => set.has(k);
  const blocks = [];
  let y = 0;

  if (has('date') && has('title')) {
    blocks.push(newBlock('date', 0, y, 2, 1), newBlock('title', 2, y, 4, 1));
    y += 1;
  } else if (has('date') || has('title')) {
    blocks.push(newBlock(has('date') ? 'date' : 'title', 0, y, 6, 1));
    y += 1;
  }
  if (has('goal')) {
    blocks.push(newBlock('goal', 0, y, 6, 1));
    y += 1;
  }
  let side = null;
  if (has('photo')) {
    const photoH = textH === 2 ? 4 : 3;
    side = SIDE_TEXT.find(has) || null;
    if (side) {
      blocks.push(newBlock('photo', 0, y, 4, photoH), newBlock(side, 4, y, 2, photoH));
    } else {
      blocks.push(newBlock('photo', 0, y, 6, photoH));
    }
    y += photoH;
  }

  // 残り：半分の幅の欄は左右に2つずつ。感想は全幅
  const rest = ['did', 'result', 'growth', 'counts', 'feeling', 'next', 'free', 'teacher'].filter((k) => has(k) && k !== side);
  let half = null; // 左半分だけ埋まっている行
  // 相手のいない半分の欄は、横いっぱいに広げる（右に空白を残さない）
  const widen = (b) => { if (b.x === 0) b.w = COLS; };
  for (const k of rest) {
    if (k === 'feeling') {
      if (half) { widen(half); y += half.h; half = null; }
      blocks.push(newBlock('feeling', 0, y, 6, 2));
      y += 2;
    } else if (half) {
      blocks.push(newBlock(k, 3, half.y, 3, textH));
      y += textH;
      half = null;
    } else {
      // 先生の補足は右下に置きたいので、左が空いていても右に置く
      const x = k === 'teacher' ? 3 : 0;
      half = newBlock(k, x, y, 3, textH);
      blocks.push(half);
      if (k === 'teacher') { y += textH; half = null; }
    }
  }
  if (half) { widen(half); y += half.h; }
  return { blocks, used: y };
}

// 自動配置。12段に収まらなければ null
export function autoLayout(kinds) {
  let r = place(kinds, 2);
  if (r.used > ROWS) r = place(kinds, 1);
  if (r.used > ROWS) return null;
  // 余った段は、いちばん下の行の欄を伸ばして埋める（白紙の帯を作らない）
  const spare = ROWS - r.used;
  if (spare > 0 && r.blocks.length) {
    const bottom = Math.max(...r.blocks.map((b) => b.y + b.h));
    for (const b of r.blocks) if (b.y + b.h === bottom) b.h += spare;
  }
  return { blocks: r.blocks };
}

export function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function inBounds(b) {
  return b.x >= 0 && b.y >= 0 && b.w >= 1 && b.h >= 1 && b.x + b.w <= COLS && b.y + b.h <= ROWS;
}

// 欄 b をこの位置・大きさにしてよいか（はみ出し・重なりがないか）
export function canPlace(blocks, b) {
  return inBounds(b) && blocks.every((o) => o.id === b.id || !overlaps(o, b));
}

// 空いている場所をさがす（欄を足すとき用）。見つからなければ null
export function findSpace(blocks, w, h) {
  for (const [ww, hh] of [[w, h], [3, 2], [3, 1], [2, 1], [1, 1]]) {
    for (let y = 0; y + hh <= ROWS; y++) {
      for (let x = 0; x + ww <= COLS; x++) {
        const c = { id: '__new', x, y, w: ww, h: hh };
        if (canPlace(blocks, c)) return { x, y, w: ww, h: hh };
      }
    }
  }
  return null;
}

export function addBlock(layout, kind) {
  const space = findSpace(layout.blocks, kind === 'photo' ? 4 : kind === 'feeling' ? 6 : 3, kind === 'photo' ? 3 : 2);
  if (!space) return null;
  const b = newBlock(kind, space.x, space.y, space.w, space.h);
  return { blocks: [...layout.blocks, b] };
}

export function cloneLayout(layout) {
  return JSON.parse(JSON.stringify(layout));
}

export const hasNum = (n) => n !== undefined && n !== null && n !== '' && !Number.isNaN(Number(n));

// 目標の欄を1行の文にする（一覧や引き継ぎの表示用）
export function goalText(block, v) {
  if (!v) return '';
  const mode = (block && block.goalMode) || 'text';
  const unit = (block && block.unit) || '';
  const parts = [];
  if (mode !== 'number' && v.text && v.text.trim()) parts.push(v.text.trim());
  if (mode !== 'text' && hasNum(v.num)) parts.push(`目標 ${v.num}${unit}`);
  if (block && block.showResult && hasNum(v.result)) parts.push(`できた ${v.result}${unit}`);
  return parts.join('　');
}

// 数の記録の項目を1つ作る
export function newCountRow(label, unit) {
  return { id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), label, unit };
}

// 数の記録を1行の文にする（例：「葉の数 5まい・赤い実の数 2こ」）
export function countsText(block, v) {
  const nums = (v && v.nums) || {};
  return ((block && block.rows) || [])
    .filter((r) => hasNum(nums[r.id]))
    .map((r) => `${r.label} ${nums[r.id]}${r.unit || ''}`)
    .join('・');
}

// 「つぎの記録をつくる」で引き継げるもの（value は新しいページの目標欄に入れる中身。結果の数は引き継がない）
export function carryOptions(layout, prevValues) {
  const goal = layout.blocks.find((b) => b.kind === 'goal');
  if (!goal) return [];
  const mode = goal.goalMode || 'text';
  const pv = prevValues || {};
  const next = (pv.next && pv.next.text || '').trim();
  const g = pv[goal.id] || {};
  const opts = [];
  if (mode !== 'number' && next) opts.push({ id: 'next2goal', label: '前回の「次回に向けて」を、今日の目標にする', text: next, value: { text: next } });
  const value = {};
  if (mode !== 'number' && g.text && g.text.trim()) value.text = g.text.trim();
  if (mode !== 'text' && hasNum(g.num)) value.num = Number(g.num);
  if (Object.keys(value).length) opts.push({ id: 'goal', label: '前回の「今日の目標」を、そのまま使う', text: goalText({ ...goal, showResult: false }, value), value });
  return opts;
}

export function todayISO(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const w = '日月火水木金土'[new Date(y, m - 1, d).getDay()];
  return `${m}月${d}日（${w}）`;
}
