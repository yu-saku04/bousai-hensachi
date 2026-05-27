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

---

## 実データ投入フェーズ 追加レビュー観点

※ 上記のPhase1/2観点に加えて、以下もレビューしてください。

### 24. data-sources.json の構造
- `id` / `name` / `agency` / `url` / `dataType` / `targetScores` / `updateFrequency` / `licenseNote` / `status` / `lastCheckedAt` / `notes` の全フィールドが存在するか
- `status` の値が `"planned" | "collected" | "converted" | "applied"` のいずれかであるか
- `targetScores` の値が `score.ts` の `ScoreKey` と一致しているか
- `url` が有効なURLの形式であるか（httpから始まるか）
- 重複 `id` がないか

### 25. インポーター設計（scripts/importers/*.ts）
- 各インポーターに `--input` / `--output` CLI引数が実装されているか
- ファイルが存在しない場合にクラッシュせず、適切なエラーメッセージを出力するか
- CSVのBOM対応（`bom: true`）が実装されているか
- `municipalityCode`（5桁JISコード）をキーとして使用しているか、または `prefecture_municipality` キーへのフォールバックがあるか
- `_debug` フィールドで計算過程を確認できるか
- `calcOverallScore` / `normalizeHigherIsBetter` / `normalizeLowerIsBetter` を正しくimportしているか

### 26. raw/processed 分離
- 生データは `data/raw/` 以下にのみ保存され、`src/` 以下には入らない設計か
- 加工済みデータは `data/processed/` 以下で、`src/data/municipalities.json` への反映は `merge-datasets.ts` 経由のみか
- `data/raw/` と `data/processed/` が `.gitignore` に含まれているか（または含めるべきか方針が決まっているか）

### 27. normalize.ts の妥当性
- `normalizeHigherIsBetter(value, min, max)` が `value === min` で 0、`value === max` で 100 を返すか
- `normalizeLowerIsBetter(value, min, max)` が `value === min` で 100、`value === max` で 0 を返すか
- `calculatePercentileScore` が空配列 / 全値同一 の場合にNaNやエラーを出さないか
- `calculateDeviationScore` が `stdDev === 0` の場合にNaN / Infinityを出さないか
- `weightedAverage` が全weightが0のときに 0 を返すか（またはNaNを出さないか）
- 戻り値が常に 0〜100 に収まるようにclampされているか

### 28. 実データ投入時の再現性
- `merge-datasets.ts` を同じ入力で2回実行しても同じ出力になるか（冪等性）
- `validate-datasets.ts` がCIステップとして使えるか（exit code 1 でエラー終了するか）
- `data/raw/tokyo-23/README.md` に手順が十分に文書化されているか
- スクリプト間の実行順序が明確に定義されているか

---

## 避難所データ投入 追加レビュー観点

### 30. CSV必須カラム検証（import-shelters.ts）
- `jisCode` / `prefecture` / `municipality` / `shelterName` / `capacity` / `disasterTypes` / `sourceUrl` / `updatedAt` の全カラムが存在しない場合に明示的なエラーで終了するか
- ヘッダー行の欠落を事前に検出するか（列数ではなく列名で判定しているか）

### 31. フィールド個別バリデーション（import-shelters.ts）
- `capacity`: 正の整数でない場合（負数・小数・空文字）にエラーを出すか
- `latitude` / `longitude`: 任意だが存在する場合に日本範囲外（lat: 20〜46, lon: 122〜154）でエラーを出すか
- `updatedAt`: YYYY-MM-DD 形式でない場合にエラーを出すか
- `sourceUrl`: http(s):// から始まらない場合にエラーを出すか
- `jisCode`: 5桁数字でない場合にエラーを出すか
- `disasterTypes`: 未知の種別（既定リスト外）の場合にエラーを出すか
- バリデーションエラーがある場合に exit code 1 で終了するか

### 32. municipality 単位集計ロジック（import-shelters.ts）
- 同一 jisCode の複数行が正しく集計されるか（shelterCount / totalCapacity の加算）
- `disasterTypes` は全施設の union（重複なし）として集計されるか
- `updatedAt` は複数行中の最新値を採用するか
- `sheltersPerTenThousand` は人口がない場合に null となり、スコア計算がフォールバックするか
- `calcShelterCapacityScore` が空配列やすべて null のデータセットで NaN / エラーを出さないか

### 33. JOINロジック（merge-datasets.ts）
- shelters.json が存在しない場合はスキップされ、既存データを壊さないか
- jisCode 優先、なければ `prefecture_municipality` でフォールバックするか
- JOIN 失敗した自治体は warnings に出力されるか（エラーで止まらないか）
- 既存の `socialSupportScore` / `infrastructureRecoveryScore` がない場合に avoid NaN処理がされているか

### 34. shelterCapacity 算出妥当性（normalize.ts）
- `calcShelterCapacityScore` は「高いほど良い」方向（sheltersPerTenThousand が多いほど高スコア）か
- パーセンタイル計算が 1件のみの場合（自分だけ）に 50 を返すか
- totalCapacity フォールバックが sheltersPerTenThousand がすべて null の場合にのみ適用されるか

### 35. 実データ投入時の再現性（全体）
- `npm run import:shelters` → `npm run merge:data` → `npm run validate:data` を同じ入力で繰り返し実行しても同じ結果になるか（冪等性）
- shelters.template.csv の注記（template であることの明示）が data-sources.json の notes に含まれているか
- 実データに置き換えるときに変更が必要なファイルが `data/raw/` 以下のみで済むか

### 36. sourcesページとの整合性（sources/page.tsx）
- data-sources.json の `status: "converted"` が sources ページに正しく表示されるか（badge 色が変わるか）
- `targetScores` に `socialSupportScore` / `infrastructureRecoveryScore` が追加されていることが sources ページで確認できるか
- `notes` に「template」と明記されていることが確認できるか

### 29. 出典表示とライセンス記載
- `/sources` ページの各データソースカードに `licenseNote` が表示されているか
- `lastCheckedAt` が表示されているか（データの鮮度を示す）
- 外部リンクに `rel="noopener noreferrer"` が付いているか
- `status === "applied"` のデータについて、結果ページの `sourceNote` フィールドに出典が記載される設計か
- CC BY 4.0 データに対して帰属表示（出典: ○○）が適切に行われているか

---

## 全国避難所CSV投入 追加レビュー観点

### 37. 全国避難所CSV取り込み仕様（import-shelters.ts）
- 必須カラムが `jisCode / prefecture / municipality / shelterName / sourceUrl / updatedAt` に限定されているか（capacity / disasterTypes は推奨に降格済み）
- `capacity` 欠損時に 0 として集計し warning ログを出すか（エラーで止まらないか）
- `disasterTypes` 欠損時に `["unknown"]` を設定し warning ログを出すか
- `sourceUrl` 欠損時は error で終了するか
- `updatedAt` 欠損時は error で終了するか
- `latitude` / `longitude` は任意であり、欠損時も処理を継続するか
- `"unknown"` が `KNOWN_DISASTER_TYPES` に含まれているか

### 38. sourceUrls 保持（import-shelters.ts / shelters.json）
- `sourceUrls: string[]` が `ShelterImportResult` に定義されているか
- 同一jisCode内の全施設の sourceUrl を重複なしで収集しているか
- `sourceUrl`（代表値: first.sourceUrl）と `sourceUrls`（全URL一覧）が両方出力されるか
- shelters.json の各エントリに `sourceUrls` フィールドが存在するか（validate-datasets.ts で検証済みか）

### 39. calculationVersion（import-shelters.ts / validate-datasets.ts）
- `calculationVersion: "shelter-v1"` が `ShelterImportResult` 型に定義されているか（リテラル型）
- 全エントリに `calculationVersion` が設定されていることを validate-datasets.ts が検証するか
- スコア算出ロジック変更時のバージョニング方針が明確か

### 40. shelters.json スキーマ検証（validate-datasets.ts）
- `validateSheltersJson` 関数が `data/processed/shelters.json` を自動検証するか
- 以下のフィールドを全エントリで検証するか:
  - `sourceUrls` が配列であること
  - `shelterCount >= 0`
  - `totalCapacity >= 0`
  - `sheltersPerTenThousand >= 0` または `null`
  - `calculationVersion` が存在すること
- shelters.json が存在しない場合は warning でスキップされるか（エラーで止まらないか）
- `--shelters PATH` オプションで検証対象パスを変更できるか

### 41. 全国CSV投入時の fail-fast（merge-datasets.ts strict mode）
- strict モードで以下が全てエラーとなり、**municipalities.json 出力前**に throw するか:
  - フォールバックJOIN（prefecture_municipality名寄せ）の発生
  - 避難所データのJOIN失敗（shelters.csvにない自治体）
  - shelters.json の未使用エントリ（base に存在しない jisCode）
  - 各 processed ファイルの未使用エントリ
- strict モードでエラーがなければ municipalities.json が正常出力されるか

### 42. municipalities.json クライアント流出有無
- `municipalities.json` が `src/data/` 以下に存在し、Next.js の Server Component からのみ読まれているか
- `"use client"` 付きコンポーネントで `municipalities.json` を直接 import していないか
- `server-only` パッケージが `src/lib/municipalities.ts` に import されているか
- `generateStaticParams` で全ページを SSG 出力することで、クライアント側に municipalities.json が bundle されていないか（Dynamic pages = 0 を確認）
- `municipality-search-index.json` は `id / prefecture / municipality / overallScore` のみを含む軽量版であり、フル JSON はクライアントに流出していないか

### 43. 実CSV投入前チェックリスト（data/raw/national/README.md との整合）
- `data/raw/national/README.md` に strict モード停止条件が正確に文書化されているか
- shelters.csv の必須カラム・推奨カラムの欠損時の挙動が文書と実装で一致しているか
- `npm run data:build:national` のコマンド順序（master:generate → import:shelters:national → merge:data:strict → validate:data --strict）が README と package.json で一致しているか

