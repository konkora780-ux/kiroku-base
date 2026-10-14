# 記録ベース

支援学校の児童生徒が、授業ごとの学習・活動をA4縦のシートに記録し、単元ごとの記録ブックとして積み重ねて振り返る、iPad向けWebアプリ。

- 企画書：[docs/proposal.md](docs/proposal.md)（元は `~/Developer/my-app/kiroku-base-proposal.md`）
- 設計書：[docs/design.md](docs/design.md)
- A4シートの見本：[docs/sheet-sample.html](docs/sheet-sample.html)

## 決めごと

- `~/Developer/my-app`（家計簿アプリ）とはコード・資料を共有しない。あちらのファイルを編集しない。
- 作り方は他の「〇〇-base」と同じ：HTML・CSS・JS（ライブラリなし、ビルドなし）、データは端末内の IndexedDB、`sw.js` でオフライン対応。
- iPad 1台の中だけで完結する。記録は外へ送らない（バックアップ・同期・共有リンクなし）。
- 児童生徒の名前は持たない・表示しない。
- 記録を失わないことを最優先：自動保存、削除はごみ箱（`deletedAt`）経由、`navigator.storage.persist()`。
- 「書く（記録入力）」と「配置を変える（様式調整）」は別画面。入力中に欄が動かないようにする。
- シートは 210mm×297mm、6列×12段のます目。画面と印刷で同じ寸法。文字を自動で縮めない。
- 各ページは作成時の様式の写し（`sheet.layout`）を持つ。基本様式（`book.template`）を変えても過去のページは変わらない。

## 構成

- `index.html` … 入口。`css/app.css`、`js/app.js`（画面と操作）、`js/kinds.js`（項目・自動配置。画面に関係しない計算）、`js/sheet.js`（A4シートの組み立て）、`js/db.js`（IndexedDB。DB名 `kiroku-base`、ストア `books` / `sheets` / `photos` / `meta`）、`js/photo.js`（写真を縮める）、`js/saver.js`（保存係：順番に保存・失敗を返す・画面を離れたら書かない）
- `sw.js` … オフライン用の控え。https のときだけ登録（手元では `?sw` を付けたときだけ）。ファイルを足したら `FILES` に追加し、`CACHE` の版を上げる
- 画面の切りかえは `#/…`（ホーム `#/`、新しい単元 `#/new`、単元 `#/book/ID`、入力 `#/sheet/ID`、様式 `#/layout/book|sheet/ID`、振り返り `#/review/本ID/ページID`、印刷 `#/print/ID`、ごみ箱 `#/trash`）
- 先生モード：「先生」ボタンを長押し（0.9秒）。状態はメモリだけ（開き直すと解除）

## 公開

GitHub Pages：https://konkora780-ux.github.io/kiroku-base/ （konkora780-ux/kiroku-base の main に push すると反映）

## 動かし方・確認

- プレビュー：`.claude/launch.json` の `kiroku-base`（ポート8795、`python3 -m http.server`）
- テスト：`npm test`（自動配置・重なり判定・引き継ぎ・目標の表示・数の記録・保存係）

## 状態

- 2026-10-14：設計確定（名前なし・バックアップなし・iPad内のみ・先生モードは長押し・GitHub Pages）。初期版を実装し、ブラウザで一通り確認済み。同日 GitHub に登録し、GitHub Pages で公開。iPad実機での確認（印刷・カメラ・再起動後の記録）はまだ。
- 2026-10-14：先生向けに「今日の目標」の書き方（文字・数字・両方、単位、できた数）、目標の候補、項目「数の記録」（先生が数える項目を足す。前回の数を表示）を追加（設計書13章）。
- 2026-10-14：評価（docs/codex-review-2026-10-14.md）を受けて、保存の確実化・様式画面の保存表示・使わない写真の片づけ・null表示・もどす・印刷前の注意を直した。様式のコピー、写真の入れかえ選択、「つぎの記録」で様式を変える流れを追加（設計書14章）。書き出し・戻す機能は相談中。
- 子要素の入れかえは `fill()` を使う（`replaceChildren` に null を渡すと「null」と表示される）。画面ごとの保存は `screenSaver()` を使う。
- 2026-10-14：振り返りで1まいずつ確認し、先生モードでページをごみ箱へ入れる機能（もとにもどす付き）を追加。再評価（docs/codex-followup-review-2026-10-14.md）の3点（保存せずに移ったときの写真削除、写真処理中のもどす、目標の候補の保存失敗）を直した（設計書15章）。
