// A4縦シート（210mm×297mm）を組み立てる。入力・様式調整・振り返り・印刷で同じものを使う。
import { kindInfo, formatDate } from './kinds.js';

export const SHEET_W = 210 * 96 / 25.4; // 画面上の大きさ（px）
export const SHEET_H = 297 * 96 / 25.4;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// opts: { unitTitle, no, layout, values, photoURL(id), mode: 'view'|'input'|'layout', selectedId, showValues（様式調整で中身も見せる） }
export function buildSheet(opts) {
  const { unitTitle, no, layout, values = {}, photoURL, mode = 'view', selectedId, showValues = false } = opts;
  const sheet = el('div', `sheet mode-${mode}`);
  const head = el('div', 'sheet-head');
  head.append(el('div', 'sheet-unit', unitTitle || ''));
  const meta = el('div', 'sheet-no');
  if (no) meta.append(el('b', null, String(no)), document.createTextNode(' まいめ'));
  head.append(meta);
  sheet.append(head);

  const grid = el('div', 'sheet-grid');
  for (const b of layout.blocks) {
    const info = kindInfo(b.kind) || { type: 'text' };
    const v = values[b.id] || {};
    const blk = el('div', `blk kind-${b.kind} size-${b.size || 'm'}`);
    if (info.teacher) blk.classList.add('teacher');
    if (b.id === selectedId) blk.classList.add('selected');
    // 高さ1段の欄は、見出しと中身を横にならべる（縦に積むと入らないため）
    if (b.h === 1 && info.type !== 'photo') blk.classList.add('row1');
    blk.dataset.id = b.id;
    blk.style.gridColumn = `${b.x + 1} / span ${b.w}`;
    blk.style.gridRow = `${b.y + 1} / span ${b.h}`;

    if (info.type !== 'photo') blk.append(el('h3', null, b.label));
    const body = el('div', 'body');
    let empty = true;

    if (mode === 'layout' && !showValues) {
      body.append(el('div', 'ph', `${info.icon || ''} ${b.label}`));
      empty = false;
    } else if (info.type === 'date') {
      if (v.text) { body.append(el('p', null, formatDate(v.text))); empty = false; }
    } else if (info.type === 'photo') {
      const ids = (v.photoIds || []).slice(0, b.photoCount || 1);
      if (ids.length) {
        body.classList.add(`photos-${ids.length}`);
        for (const id of ids) {
          const img = el('img');
          img.alt = '写真';
          const url = photoURL && photoURL(id);
          if (url) img.src = url;
          body.append(img);
        }
        empty = false;
      }
    } else {
      if (info.type === 'choice' && v.choices && v.choices.length) {
        const chips = el('div', 'chips');
        for (const c of v.choices) chips.append(el('span', 'chip', c));
        body.append(chips);
        empty = false;
      }
      if (v.text && v.text.trim()) { body.append(el('p', null, v.text)); empty = false; }
    }

    if (empty) {
      blk.classList.add('empty');
      if (mode === 'input') {
        const hint = info.type === 'photo' ? '📷 タップして写真' : info.teacher ? '先生が書きます' : '✏️ タップして書く';
        body.append(el('div', 'ph', hint));
      } else if (mode === 'layout') {
        body.append(el('div', 'ph', `${info.icon || ''} ${b.label}`));
      }
    }
    blk.append(body);
    if (mode === 'layout') blk.append(el('div', 'grip'));
    grid.append(blk);
  }
  sheet.append(grid);
  return sheet;
}

// 入りきらない欄に印を付ける。印の付いた欄の数を返す
export function markOverflow(sheet) {
  let n = 0;
  for (const blk of sheet.querySelectorAll('.blk')) {
    blk.classList.remove('over');
    if (blk.classList.contains('kind-photo')) continue;
    const body = blk.querySelector('.body');
    if (body && body.scrollHeight > body.clientHeight + 2) {
      blk.classList.add('over');
      n++;
    }
  }
  return n;
}

// シートを、決まった幅・高さに収まるよう縮めて表示する箱に入れる
export function fitBox(sheet, maxW, maxH) {
  const scale = Math.min(maxW / SHEET_W, maxH ? maxH / SHEET_H : Infinity);
  const box = el('div', 'sheet-fit');
  box.style.width = `${SHEET_W * scale}px`;
  box.style.height = `${SHEET_H * scale}px`;
  sheet.style.transform = `scale(${scale})`;
  box.append(sheet);
  box.dataset.scale = scale;
  return box;
}
