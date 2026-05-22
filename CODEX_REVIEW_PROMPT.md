# Codex レビュープロンプト - 全国防災偏差値

以下のNext.js 16 + TypeScript プロジェクトをレビューしてください。

## プロジェクト概要

「全国防災偏差値」- 市区町村ごとの防災リスクを偏差値でわかりやすく数値化するWebサービスのMVP。

- フレームワーク: Next.js 16（App Router）
- 言語: TypeScript
- スタイリング: Tailwind CSS v4
- データ: 静的JSON
- ホスティング: Vercel想定

## レビュー対象ファイル

```
src/
├── app/
│   ├── layout.tsx
│   ├── page.tsx
│   ├── ranking/page.tsx
│   └── result/[prefecture]/[municipality]/page.tsx
├── components/
│   ├── AdPlaceholder.tsx
│   ├── Disclaimer.tsx
│   ├── RiskCard.tsx
│   ├── ScoreCard.tsx
│   ├── SearchForm.tsx
│   └── ShareButtons.tsx
├── data/
│   └── municipalities.json
├── lib/
│   ├── municipalities.ts
│   └── score.ts
└── types/
    └── municipality.ts
```

## レビュー観点（すべて確認してください）

### 1. TypeScript安全性
- 型定義の適切さ（null/undefinedの扱い）
- as キャスト・any型の乱用がないか
- データ欠損時（スコアがundefined・NaN・範囲外）の型安全性
- municipalities.json のimportに型が適切に当たっているか

### 2. Next.js 16 App Router構成
- `params` が `Promise<{...}>` として正しくawaitされているか（Next.js 16仕様）
- generateStaticParamsの戻り値が正しいか
- Server Components と Client Components の使い分けが適切か
- `"use client"` ディレクティブが必要な箇所にのみ付いているか
- generateMetadataが正しく実装されているか

### 3. ビルドエラー・型エラー
- `npm run build` でエラーが出ないか
- `npx tsc --noEmit` でエラーが出ないか
- ESLintエラーがないか

### 4. データ欠損時の耐性
- JSONデータが欠損・不正な場合に画面がクラッシュしないか
- スコアがundefined/NaN/範囲外の場合の処理
- 存在しない都道府県・市区町村へのアクセス時の404処理
- `notFound()` の使い方が適切か

### 5. score.ts のスコア判定ロジック
- clampScore関数がNaN・undefined・範囲外を正しく処理するか
- getScoreLevel / getScoreLevelLabel のロジックが仕様通りか
  - 70以上: 比較的安全
  - 50〜69: 標準
  - 30〜49: 注意
  - 29以下: 要警戒
- calcOverallScore の重み付けが適切か
- 色クラスがTailwind CSS v4で正しく機能するか

### 6. municipalities.ts の検索ロジック
- getMunicipalityByParams でのdecodeURIComponentが適切か
- エンコードされたURLパラメータから正しくデータを引けるか
- buildResultPath のencodeURIComponentが正しいか
- パフォーマンス（大量データ時のfind処理のボトルネックがないか）

### 7. UI/UX
- スマホ（375px幅）での表示に問題がないか
- フォームのバリデーション（都道府県未選択で市区町村選択できないか）
- ローディング状態・エラー状態の扱い
- 不安を煽る表現になっていないか
- 行動提案が具体的で実用的か

### 8. アクセシビリティ
- セマンティックなHTML（header, nav, main, section, ol, li等）
- aria-label の適切な使用
- フォームのlabel-input関連付け（for/id）
- キーボード操作への対応
- 色のコントラスト比

### 9. Vercelデプロイ適性
- 環境変数なしでビルド・起動できるか
- 静的生成（generateStaticParams）が正しく機能するか
- 画像最適化（next/imageの使用）
- フォントの読み込み最適化

### 10. CSV→JSON拡張性（Phase2対応）
- Municipality型にphase2用フィールド（optional）が用意されているか
- JSONデータの追加時にコードの変更が最小限で済む設計か
- 都道府県別フィルタリング関数が用意されているか

### 11. Phase2・Phase3への拡張性
- 検索機能追加時のSearchForm拡張がしやすいか
- 地図（OpenStreetMap/GeoJSON）追加時の構造的な問題がないか
- Phase3の独自指数フィールドがMunicipality型に定義されているか
- AIコメント生成機能の追加ポイントが明確か

### 12. 広告枠追加のしやすさ
- AdPlaceholder.tsx が各ページに配置されているか
- Google AdSense追加時の変更箇所が最小限か
- 広告枠の配置がUX的に適切か（コンテンツの邪魔にならないか）

### 13. セキュリティ
- XSS脆弱性がないか（dangerouslySetInnerHTML の使用がないか）
- URLパラメータのサニタイズが適切か
- 外部リンク（SNSシェア）に rel="noopener noreferrer" が付いているか
- JSONインジェクションの可能性がないか

### 14. パフォーマンス
- 不要なClient Componentがないか
- 画像・フォントの最適化
- 静的生成（SSG）が最大限活用されているか
- バンドルサイズの問題がないか

## レビュー結果の形式

以下の形式で回答してください：

### 重大な問題（buildが通らない / クラッシュする）
- [問題点] / [対象ファイル] / [修正案]

### 中程度の問題（動くが改善すべき）
- [問題点] / [対象ファイル] / [修正案]

### 軽微な問題・提案（あれば対応推奨）
- [問題点] / [対象ファイル] / [修正案]

### 良い点（維持すべき設計）
- [良い点]

### Phase2実装時の注意事項
- [注意点]

### Phase3実装時の注意事項
- [注意点]

---

## Phase2 追加レビュー観点

※ 上記のPhase1観点に加えて、以下もレビューしてください。

### 15. 都道府県フィルターの安全性（ranking/page.tsx）
- `searchParams` から受け取った `prefecture` の値が、既知の都道府県リストに含まれているか検証されているか
- 未知の値でもクラッシュせず、全国ランキングにフォールバックするか
- XSSやインジェクションのリスクがないか

### 16. URLクエリ処理（PrefectureFilter.tsx）
- `useSearchParams` の使用が適切か（Suspenseでラップされているか）
- `useRouter.push` でのURLパラメータ生成が安全か
- 既存のクエリパラメータを壊さずに `prefecture` だけ更新しているか

### 17. 検索フォームの入力安全性（MunicipalitySearch.tsx / SearchForm.tsx）
- キーワード入力値をそのまま表示・クエリに使用する際のXSSリスクがないか
- 入力値のサニタイズが適切か（Reactの通常エスケープで十分かを確認）
- 検索結果が0件のときのUXが適切か

### 18. CSV→JSON変換スクリプトの拡張性（scripts/csv-to-json.ts）
- `parseScore` の欠損値処理が Municipality 型の仕様と合致しているか
- ダブルクォート内のカンマ対応が必要か（現在は非対応のTODOコメントあり）
- 重複IDの検出・警告ロジックが不足していないか
- 大量データ（1700件以上）でもメモリ・パフォーマンス上の問題がないか

### 19. sourcesページの免責表示（sources/page.tsx）
- 外部URLへのリンクに `rel="noopener noreferrer"` が付いているか
- 免責事項の文言が法的観点から適切か（「一切の責任を負いません」の記述）
- 「公式サイト →」のリンクのセキュリティ

### 20. 実データ投入時の型安全性
- `Municipality` 型の optional フィールドが null ではなく undefined として扱われているか
- JSON.stringify 時に undefined フィールドが省略されることへの考慮はあるか
- `postalCode` など文字列フィールドに数値が入ってきた場合のハンドリング

### 21. Phase3指数追加時の拡張性
- `Municipality` 型の Phase3フィールド定義が `score.ts` の `calcOverallScore` と整合しているか
- 新指数追加時に `RISK_ITEMS` 定数への追加だけで対応できるか
- AIコメント (`aiComment`) フィールドの追加時にXSSリスクがないか（dangerouslySetInnerHTMLを使わないこと）

### 22. タブ型SearchFormのアクセシビリティ
- `role="tablist"` / `role="tab"` / `aria-selected` が正しく使われているか
- キーボードで各タブを選択できるか（Tab/矢印キー）
- タブパネルに `role="tabpanel"` と `aria-labelledby` が必要か

### 23. ランキングページの動的レンダリング
- `searchParams` を使用することで `/ranking` が動的（ƒ）になっているが、パフォーマンス上問題ないか
- フィルターなし時も動的レンダリングになる点の代替案があるか
  - 例: フィルターUIをClient Componentに切り出し、SSGページとして維持する設計

