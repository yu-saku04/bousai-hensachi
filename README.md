# 全国防災偏差値

> あなたの街の災害リスクを、わかりやすく数値化

市区町村ごとの防災リスクを偏差値形式でわかりやすく数値化するWebサービスのMVPです。

---

## サービス概要

- **サービス名**: 全国防災偏差値
- **コンセプト**: 難しい防災データを一般ユーザーが一瞬で理解できる形に翻訳する
- **特徴**: 不安を煽らず、具体的な行動（避難準備・家族の集合場所確認など）につながるUI/UX
- **フェーズ**: 現在 Phase1（MVP）実装済み

---

## 技術構成

| 項目 | 採用技術 |
|------|----------|
| フレームワーク | Next.js 16（App Router） |
| 言語 | TypeScript |
| スタイリング | Tailwind CSS v4 |
| データ | 静的JSON（全国master 1,918自治体 / GSI指定避難所CSV 83,148施設・1,714自治体投入済み） |
| ホスティング | Vercel 想定 |
| 有料API | なし |

---

## 起動方法

```bash
npm install
npm run dev
# → http://localhost:3000 で確認
```

## ビルド方法

```bash
npm run build
npm run start
```

## 型チェック

```bash
npx tsc --noEmit
```

## Lint

```bash
npm run lint
```

---

## ディレクトリ構成

```
src/
├── app/
│   ├── layout.tsx                          # ルートレイアウト
│   ├── page.tsx                            # トップページ (/)
│   ├── ranking/
│   │   └── page.tsx                        # ランキングページ (/ranking)
│   └── result/[prefecture]/[municipality]/
│       └── page.tsx                        # 結果ページ (/result/[pref]/[muni])
├── components/
│   ├── AdPlaceholder.tsx                   # 広告枠プレースホルダー
│   ├── Disclaimer.tsx                      # データ注意書き
│   ├── MunicipalitySearch.tsx              # [Phase2] キーワード検索コンポーネント
│   ├── PrefectureFilter.tsx                # [Phase2] 都道府県フィルター（URLクエリ連動）
│   ├── RiskCard.tsx                        # リスク項目カード
│   ├── ScoreCard.tsx                       # 総合スコアカード
│   ├── SearchForm.tsx                      # 検索フォーム（選択/キーワード/住所タブ）
│   └── ShareButtons.tsx                    # SNSシェアボタン
├── data/
│   └── municipalities.json                 # 市区町村データ（全国master 1,918自治体）
├── lib/
│   ├── municipalities.ts                   # データアクセス・検索・ランキングロジック
│   └── score.ts                            # スコア判定ロジック
├── types/
│   └── municipality.ts                     # 型定義・定数（Phase2/3フィールド含む）
scripts/
└── csv-to-json.ts                          # [Phase2] CSV→JSON変換スクリプト雛形
```

---

## データ構造

`src/data/municipalities.json` に市区町村データを格納します。

```typescript
interface Municipality {
  id: string;              // 一意のID（例: "tokyo-setagaya"）
  prefecture: string;      // 都道府県名
  municipality: string;    // 市区町村名
  overallScore: number;    // 総合防災偏差値（0〜100）
  floodRisk: number;       // 洪水リスク（高いほど安全）
  earthquakeRisk: number;  // 地震リスク（高いほど安全）
  fireRisk: number;        // 火災リスク（高いほど安全）
  agingRisk: number;       // 高齢化リスク（高いほど余裕あり）
  shelterCapacity: number; // 避難所余裕度（高いほど余裕あり。現行は主に人口1万人あたり避難所数を優先）
  comment: string;         // 診断コメント
  actionTips: string[];    // 行動提案リスト
  sourceNote: string;      // データ出典注記
  // Phase2拡張用（optional）
  postalCode?: string;
  latitude?: number;
  longitude?: number;
  population?: number;
  capacityPerPopulation?: number | null; // 人口1人あたり収容人数（将来の重みづけ候補）
  updatedAt?: string;
  // Phase3拡張用（optional）
  isolationIndex?: number;
  childcareDisasterIndex?: number;
  emotionalResilienceIndex?: number;
  familyDisasterIndex?: number;
  postDisasterLivingRisk?: number;
  aiComment?: string;
}
```

## スコアルール

| スコア | 判定 |
|--------|------|
| 70以上 | 比較的安全 |
| 50〜69 | 標準 |
| 30〜49 | 注意 |
| 29以下 | 要警戒 |

**重要**: リスク項目のスコアは高いほど「安全・余裕あり」を示します。

---

## フェーズ定義

### Phase1（現在実装済み）- MVP

- 市区町村選択による診断
- 総合防災偏差値表示
- 洪水・地震・火災・高齢化・避難所余裕度のリスク表示
- ランキングページ
- 静的JSON（全国master 1,918自治体）
- Vercel公開対応
- スマホ優先UI
- SNSシェア機能
- 広告枠プレースホルダー

### Phase2（実装済み）- データ強化・検索拡張

- 都道府県別ランキング（URLクエリ `?prefecture=東京都` 対応）
- 市区町村名キーワード検索（リアルタイム候補表示）
- 住所・郵便番号検索UI（プレースホルダー・近日公開）
- データ出典ページ `/sources`（免責事項・利用予定データ一覧）
- CSV→JSON変換スクリプト雛形（`scripts/csv-to-json.ts`）
- Municipality型にPhase2フィールド追加（agingRate, floodSource等）
- データ注意表示を各ページに追加（一部指標は初期値・設計値を含む）
- SearchFormをタブ型UI（選択/キーワード/住所）に拡張
- 残タスク: 実データ拡充・OpenStreetMap地図・時系列データ対応

### Phase3（実装済み）- TEMMEI独自指数・3層スコアリング

- 6指標追加: `isolationRisk` / `childcareStressRisk` / `emotionalRecoveryRisk` / `socialSupportScore` / `infrastructureRecoveryScore` / `familyDisasterPreparedness`
- 「物理的安全 × 社会回復力 × 感情回復力」の3層スコアリング
- カテゴリ別ランキングページ `/ranking/emotional` `/ranking/social`
- スコア算出方法ページ `/methodology`
- 結果ページをカテゴリタブ+RadarChart+ルールベースAIコメントに刷新
- JSON-LD (BreadcrumbList/Article/FAQPage/WebPage) による構造化データ
- 市区町村データを全国master 1,918自治体へ拡張
- result SSG 1,918自治体、都道府県ランキング 47都道府県、Dynamic pages = 0 を維持

### 実データ投入フェーズ（実装済み・データ収集中）

- `src/data/data-sources.json` — 14件のデータソースカタログ（ステータス管理付き）
- `src/app/sources/page.tsx` — データ収集状況を可視化するカタログページ
- `src/lib/normalize.ts` — スコア正規化ユーティリティ（パーセンタイル/偏差/線形）
- `scripts/importers/` — 6種のデータインポータースクリプト
- `scripts/merge-datasets.ts` — processed/ データを municipalities.json に統合
- `scripts/validate-datasets.ts` — 投入後の品質チェック（必須フィールド/範囲/重複/乖離）
- `data/raw/tokyo-23/README.md` — 東京23区データ収集ガイド

**データ投入フロー:**
```bash
# 1. 各インポーター実行
npx ts-node scripts/importers/import-shelters.ts --input data/raw/shelters.csv --output data/processed/shelter-scores.json
npx ts-node scripts/importers/import-population.ts --input data/raw/census-2020.csv --output data/processed/population-scores.json
# ... 他のインポーターも同様

# 2. 統合
npx ts-node scripts/merge-datasets.ts --base src/data/municipalities.json --processed data/processed/ --output src/data/municipalities.json

# 3. 検証
npx ts-node scripts/validate-datasets.ts --input src/data/municipalities.json

# 4. ビルド確認
npm run build
```

---

## Phase2での変更まとめ

### 追加ページ
- `/sources` — データ出典・免責事項ページ

### 追加コンポーネント
- `MunicipalitySearch.tsx` — キーワード検索（リアルタイム）
- `PrefectureFilter.tsx` — 都道府県フィルター（URLクエリ連動）

### 主な変更
- `SearchForm.tsx` — タブUI（選択/キーワード/住所）に拡張
- `ranking/page.tsx` — 都道府県フィルター対応（searchParams使用）
- `municipalities.ts` — `searchMunicipalities()` 追加
- `municipality.ts` — `agingRate`/`floodSource`等のフィールド追加
- `municipalities.json` — 新フィールドに仮値を追加

### データ変換コマンド（CSV実データ投入時）
```bash
# data/municipalities.csv を用意してから実行
npm run convert:data
```

## 全国CSVデータ投入手順（本番）

### shelter-v1 の対象データ方針

現行の `shelter-v1` は **指定避難所CSV** を主対象にします。`shelterCapacity` は、避難所の余裕度全体ではなく、主に人口1万人あたり指定避難所数を優先して算出します。

指定緊急避難場所CSVは災害種別を取得できますが、指定避難所数スコアとは意味が異なるため、現行では補完データまたは将来の `shelter-v2` / 別指標候補として扱います。`capacity` は現時点では補助データとして保持し、将来の重みづけ候補です。

### 全国避難所CSV配置場所

```
data/raw/national/shelters.csv   ← 全国分CSV（shelter-v1 は指定避難所CSVを主対象）
data/raw/tokyo-23/shelters.csv   ← 東京23区分CSV（東京都から取得）
```

### 全国CSV実行手順

```bash
# GSI CSVを標準CSVへ変換する場合
npm run convert:gsi-shelters -- \
  --input data/raw/gsi/shelters.csv \
  --output data/raw/national/shelters.csv \
  --master data/master/municipalities-base.json \
  --source-url https://hinanmap.gsi.go.jp/hinanjocp/hinanbasho/koukaidate.html \
  --updated-at 2026-05-25

# 全国master生成、避難所import、strict merge、strict validateを一括実行
npm run data:build:national

# strict なしで実行する場合
npm run data:build:loose
```

### data:build vs data:build:loose

| コマンド | validate モード | jisCode未設定 | 用途 |
|---|---|---|---|
| `data:build` | **strict** | error → 終了 | CI・本番デプロイ前 |
| `data:build:national` | **strict** | error → 終了 | 全国CSV投入 |
| `data:build:loose` | loose | warning のみ | 開発・部分投入時 |

---

## 東京23区（テンプレート）投入手順

---

## 避難所データ投入手順

### shelters.template.csv のカラム説明

| カラム | 必須 | 説明 | 例 |
|---|---|---|---|
| `jisCode` | ✅ | 市区町村JISコード（5桁） | `13112` |
| `prefecture` | ✅ | 都道府県名 | `東京都` |
| `municipality` | ✅ | 市区町村名 | `世田谷区` |
| `shelterName` | ✅ | 施設名 | `世田谷小学校` |
| `address` | - | 住所 | `東京都世田谷区世田谷1-1-1` |
| `latitude` | - | 緯度（20〜46の範囲） | `35.6464` |
| `longitude` | - | 経度（122〜154の範囲） | `139.6530` |
| `capacity` | ✅ | 収容人数（正の整数） | `350` |
| `disasterTypes` | ✅ | 対応災害種別（パイプ区切り） | `earthquake\|flood` |
| `sourceUrl` | ✅ | 出典URL（http(s)://から始まる） | `https://...` |
| `updatedAt` | ✅ | データ更新日（YYYY-MM-DD） | `2026-05-22` |

`disasterTypes` に使用できる値: `earthquake`, `flood`, `fire`, `tsunami`, `volcano`, `landslide`, `storm`, `inland_flood`

### import-shelters 実行方法

```bash
# テンプレートCSVで動作確認
npm run import:shelters
# = tsx scripts/importers/import-shelters.ts
#   --input data/raw/tokyo-23/shelters.template.csv
#   --output data/processed/shelters.json

# 実データで実行する場合
npx tsx scripts/importers/import-shelters.ts \
  --input data/raw/tokyo-23/shelters.csv \
  --output data/processed/shelters.json
```

出力: `data/processed/shelters.json`（自治体ごとに集計された避難所スコア）

現行の `shelterCapacity` は、主に「人口1万人あたり避難所数」を優先して算出しています。
収容人数は `capacityPerPopulation` として保持し、将来の `shelter-v2` 以降で重みづけに使う可能性があります。

### merge-datasets 実行方法

```bash
# shelters.json を municipalities.json に統合
npm run merge:data
# = tsx scripts/merge-datasets.ts
#   --base src/data/municipalities.json
#   --processed data/processed/
#   --output src/data/municipalities.json
```

統合内容:
- `shelterCapacity` を実データで上書き
- `socialSupportScore` を 70%既存値 + 30%避難所スコアでブレンド
- `infrastructureRecoveryScore` を 80%既存値 + 20%避難所スコアでブレンド
- `shelterSource` / `dataUpdatedAt` を設定
- `overallScore` を再計算

### validate-datasets 実行方法

```bash
# 統合後のデータ品質確認
npm run validate:data
# = tsx scripts/validate-datasets.ts
#   --input src/data/municipalities.json
```

検証内容: 必須フィールド、スコア範囲、重複ID、overallScore乖離、Phase3カバレッジ、避難所関連フィールド

### まとめてのデータ投入フロー

```bash
npm run import:shelters   # 1. CSVを変換
npm run merge:data         # 2. municipalities.json に統合
npm run validate:data      # 3. 品質確認
npm run build             # 4. ビルド確認
```

## 全国マスター生成フロー（generate-national-master）

`scripts/generate-national-master.ts` は `data/raw/national/municipalities.csv` から
`data/master/municipalities-base.json` を生成するスクリプトです。

### municipalities.csv のカラム説明

| カラム | 必須 | 説明 | 例 |
|---|---|---|---|
| `jisCode` | ✅ | 市区町村JISコード（5桁数字） | `13112` |
| `prefecture` | ✅ | 都道府県名 | `東京都` |
| `municipality` | ✅ | 市区町村名 | `世田谷区` |
| `population` | - | 人口 | `930000` |
| `agingRate` | - | 高齢化率（%） | `21.8` |
| `latitude` | - | 緯度 | `35.6464` |
| `longitude` | - | 経度 | `139.6530` |
| `id` | - | 一意ID（省略時は `muni-{jisCode}`） | `tokyo-setagaya` |

### 検証内容

- 必須フィールド空チェック・jisCode 5桁数字チェック
- jisCode 重複（エラー）・id 重複（エラー）
- 既存 `municipalities-base.json` があれば jisCode でスコア等を引き継ぎ
- 新規エントリはデフォルトスコア 50 で初期化

### 実行方法

```bash
# CSV → municipalities-base.json を生成（既存スコアを引き継ぎ）
npm run master:generate

# 手動実行の場合
npx tsx scripts/generate-national-master.ts \
  --input  data/raw/national/municipalities.csv \
  --output data/master/municipalities-base.json \
  --base   data/master/municipalities-base.json
```

### 全国1700件対応の流れ

```bash
# 1. 全国CSVを配置
#    data/raw/national/municipalities.csv に jisCode/prefecture/municipality を記載

# 2. マスター再生成（既存スコアを自動引き継ぎ）
npm run master:generate

# 3. 各データインポーター実行
npm run import:shelters:national

# 4. 統合 + strict バリデーション
npm run data:build

# 5. ビルド確認
npm run build
```

### merge:data の strict モード

| コマンド | 動作 | フォールバックJOIN |
|---|---|---|
| `npm run merge:data` | 通常モード | ⚠️ 警告のみ |
| `npm run merge:data:strict` | strict モード | ❌ エラーで終了 |

`data:build` は `merge:data:strict` + `validate:data --strict` を組み合わせた CI 用コマンドです。

---

## 全国避難所CSV投入フェーズ

### 概要

全国避難所CSVを `data/raw/national/` に配置し、`npm run data:build:national` を実行するだけで
全国データを `src/data/municipalities.json` に安全に投入できます。

### shelters.csv の仕様

| カラム | 必須/推奨 | 欠損時の扱い |
|---|---|---|
| `jisCode` | ✅ 必須 | エラー |
| `prefecture` | ✅ 必須 | エラー |
| `municipality` | ✅ 必須 | エラー |
| `shelterName` | ✅ 必須 | エラー |
| `sourceUrl` | ✅ 必須 | エラー |
| `updatedAt` | ✅ 必須（YYYY-MM-DD） | エラー |
| `capacity` | 推奨 | 0 として集計（warning） |
| `disasterTypes` | 推奨（パイプ区切り） | `unknown` を設定（warning） |
| `address` | オプション | スキップ |
| `latitude` | オプション | スキップ |
| `longitude` | オプション | スキップ |

詳細仕様: `data/raw/national/README.md` を参照。

### npm run data:build:national の使い方

```bash
# 1. CSVを配置
#    data/raw/national/municipalities.csv  ← 全国市区町村マスター
#    data/raw/national/shelters.csv        ← 全国避難所データ

# 2. 全国ビルド（一括実行）
npm run data:build:national

# 内部実行順序:
# 1. master:generate    → municipalities-base.json（スコア引き継ぎ）
# 2. import:shelters:national → data/processed/shelters.json
# 3. merge:data:strict  → municipalities.json + search-index（strict モード）
# 4. validate:data --strict → 品質チェック + shelters.json スキーマ検証
```

### strict mode で止まる条件

| 条件 | 説明 |
|---|---|
| jisCode 未設定・不正形式 | municipalities.csv / shelters.csv 内 |
| 同一jisCode に prefecture/municipality 混在 | shelters.csv 内 |
| フォールバックJOIN発生 | jisCode不一致でmunicipality名による結合に落ちた |
| shelters.json 未使用エントリ | shelters.csv の自治体が municipalities-base.json に不在 |
| search-index 件数・内容不一致 | id / prefecture / municipality / overallScore が異なる |
| shelters.json スキーマ違反 | jisCode不正 / sourceUrl不正 / sourceUrls不正 / 負数 / calculationVersion不一致 |

### 実CSV投入前チェックリスト

- [ ] jisCode が5桁数字であること
- [ ] municipalities.csv と shelters.csv の jisCode が完全一致していること
- [ ] sourceUrl が有効なURL（`https://...`）であること
- [ ] updatedAt が `YYYY-MM-DD` 形式であること
- [ ] 文字コードが UTF-8（BOM付き可）であること
- [ ] `npm run data:build:national` が strict モードでエラーなし通過すること
- [ ] `npm run build` が成功すること（Dynamic pages = 0 維持）

---

## 次にやること（実データ拡充）

1. e-Stat等による人口・高齢化率・単身世帯などの実データ拡充
2. 自治体オープンデータによる収容人数・災害種別の補完（将来の `shelter-v2` 候補）
3. 郵便番号APIまたは静的住所データとの連携実装
4. OpenStreetMap / GeoJSON 地図ビュー追加
5. 時系列データ・更新履歴の整備

---

## Vercelデプロイ

```bash
npx vercel
```

または GitHubリポジトリをVercelに接続して自動デプロイ。
環境変数は現在不要（静的JSONのみ使用）。

---

## 注意事項

- GSI指定避難所CSV 83,148施設 / 1,714自治体は投入済みです。一部指標は初期値・設計値を含みます
- 防災情報の最終確認は必ず自治体・国土交通省・消防庁等の公的機関の情報をご確認ください
- 本サービスの情報は防災意識向上を目的としており、正確性・完全性を保証するものではありません
