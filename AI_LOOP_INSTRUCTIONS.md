# AIループ手順書 - 全国防災偏差値

Claude Code + Codex を使ったAIループ開発フローです。

---

## 基本フロー

```
Claude Code で実装
    ↓
npm install
    ↓
npm run build（成功するまでループ）
    ↓
CODEX_REVIEW_PROMPT.md を Codex に投げる
    ↓
Codex レビュー結果を Claude Code に戻す
    ↓
指摘事項を修正（Claude Code）
    ↓
npm run build（成功するまでループ）
    ↓
Vercel デプロイ
```

---

## ステップ詳細

### Step 1: Claude Code で実装

```bash
# Claude Code を起動
claude

# または特定のタスクを指示
# 例: 「ranking/page.tsx の都道府県別フィルター機能を追加してください」
```

### Step 2: 依存パッケージをインストール

```bash
cd /path/to/bousai-hensachi
npm install
```

### Step 3: ビルド確認

```bash
npm run build
```

エラーが出た場合は Step 4 へ。成功した場合は Step 5 へ。

### Step 4: ビルドエラーを修正（Claude Code）

エラーメッセージを Claude Code に貼り付けて修正依頼：

```
以下のビルドエラーを修正してください：
[エラーメッセージをここに貼り付け]
```

修正後、Step 3 に戻る（ビルド成功まで繰り返す）。

### Step 5: Codex レビューを実施

`CODEX_REVIEW_PROMPT.md` の内容をコピーし、各ファイルのコードと合わせて Codex に投げる。

**Codex への投げ方（例）**:
```
[CODEX_REVIEW_PROMPT.md の内容]

以下がレビュー対象のコードです：

---
### src/types/municipality.ts
[コードを貼り付け]

---
### src/lib/score.ts
[コードを貼り付け]

（以下、全ファイルを貼り付け）
```

### Step 6: Codex レビュー結果を Claude Code に戻す

Codex の回答を Claude Code に貼り付けて修正依頼：

```
Codex のレビュー結果を受け取りました。以下の指摘事項を修正してください：
[Codex の回答をここに貼り付け]
```

### Step 7: 指摘事項を修正

Claude Code が自動修正。修正後は Step 3（ビルド確認）に戻る。

### Step 8: ビルド成功まで繰り返す

```bash
npm run build
# エラーなし → デプロイへ
```

### Step 9: 型チェック・Lint（最終確認）

```bash
npx tsc --noEmit
npm run lint
```

### Step 10: Vercel デプロイ

```bash
npx vercel
# または GitHub リポジトリを Vercel に接続して自動デプロイ
```

---

## Phase別の実装サイクル

### Phase2 実装時

1. 実データ（CSV）を入手
2. `scripts/csv-to-json.ts` を作成（Claude Code に依頼）
3. `src/data/municipalities.json` を実データで更新
4. 郵便番号検索・住所検索を `SearchForm.tsx` に追加（Claude Code に依頼）
5. 都道府県別ランキングを `ranking/page.tsx` に追加（Claude Code に依頼）
6. ビルド → Codex レビュー → 修正 → デプロイ

### Phase3 実装時

1. TEMMEI独自指数の算出ロジックを定義
2. `src/lib/score.ts` に新スコア計算関数を追加（Claude Code に依頼）
3. `Municipality` 型の optional フィールドに実データを投入
4. AIコメント生成（Claude API連携）を実装（Claude Code に依頼）
5. ビルド → Codex レビュー → 修正 → デプロイ

---

## よく使うコマンド

```bash
# 開発サーバー起動
npm run dev

# ビルド確認
npm run build

# 型チェック（buildなし）
npx tsc --noEmit

# ESLint
npm run lint

# Vercel デプロイ（プレビュー）
npx vercel

# Vercel デプロイ（本番）
npx vercel --prod
```

---

## トラブルシューティング

### `params` 型エラー（Next.js 16）

Next.js 16 では `params` は `Promise<{...}>` 型です。

```typescript
// 正しい書き方
export default async function Page({
  params,
}: {
  params: Promise<{ prefecture: string; municipality: string }>;
}) {
  const { prefecture, municipality } = await params;
  // ...
}
```

### generateStaticParams のエラー

```typescript
export async function generateStaticParams() {
  return getAllMunicipalities().map((m) => ({
    prefecture: encodeURIComponent(m.prefecture),
    municipality: encodeURIComponent(m.municipality),
  }));
}
```

### Tailwind CSS v4 のクラスが効かない

Tailwind CSS v4 では `globals.css` に `@import "tailwindcss"` が必要です。

### JSONデータの型エラー

```typescript
import rawData from "@/data/municipalities.json";
const data = rawData as Municipality[];
```

---

## 注意事項

- コード変更後は必ず `npm run build` でビルドを確認すること
- Codex レビューは実装完了後・デプロイ前に必ず実施すること
- 仮データのまま公開する場合は `sourceNote` にその旨を明示すること
- 実データ投入前に著作権・利用規約を必ず確認すること

---

## Phase2 実装サイクル

### Phase2 実装手順

```bash
# Phase2実装後のビルド確認
cd /path/to/bousai-hensachi
npm run build
npm run lint

# 型チェック
npx tsc --noEmit
```

### Phase2 Codexレビューポイント

`CODEX_REVIEW_PROMPT.md` のPhase2追加観点（観点15〜23）を重点的にレビュー:
- 都道府県フィルターの安全性
- URLクエリ処理
- 検索フォームのXSSリスク
- CSV→JSON変換の拡張性

### Phase2で追加したコマンド

```bash
# CSVデータを municipalities.json に変換（data/municipalities.csv が必要）
npm run convert:data
```

### Phase2でのビルド特性の変化

- `/ranking` が SSGからDynamic（ƒ）に変更（searchParams使用のため）
- フィルターなし時のキャッシュ効率のためにISRまたはCDNキャッシュ設定を検討
- Vercelではデフォルトでエッジキャッシュが効くため問題になりにくい

### Phase2→Phase3への移行チェックリスト

- [ ] 実データ（CSV）の入手・ライセンス確認
- [ ] `npm run convert:data` で実データ変換・動作確認
- [ ] 実データ投入後のビルド成功確認
- [ ] Phase3指数の算出ロジック定義
- [ ] Claude API連携の設計・実装（aiComment生成）
