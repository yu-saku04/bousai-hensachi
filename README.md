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
| データ | 静的JSON（仮データ） |
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
│   └── municipalities.json                 # 市区町村データ（現在は仮データ10件）
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
  shelterCapacity: number; // 避難所余裕度（高いほど余裕あり）
  comment: string;         // 診断コメント
  actionTips: string[];    // 行動提案リスト
  sourceNote: string;      // データ出典注記
  // Phase2拡張用（optional）
  postalCode?: string;
  latitude?: number;
  longitude?: number;
  population?: number;
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
- 静的JSON（仮データ10件）
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
- 仮データ注意表示を各ページに追加
- SearchFormをタブ型UI（選択/キーワード/住所）に拡張
- 残タスク: 実データ投入・OpenStreetMap地図・全市区町村対応

### Phase3（未実装）- TEMMEI独自指数

- 災害時孤立指数
- 子育て防災指数
- 感情耐災性スコア
- 家族防災力スコア
- 災害後生活リスク
- AIコメント生成（Claude API連携）
- 「物理防災 × 社会防災 × 感情防災」の3層スコアリング

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

## Phase2 残タスク（次にやること）

1. 実データCSVの入手・ライセンス確認（国土交通省・消防庁等）
2. `npm run convert:data` で実データ変換
3. 郵便番号APIまたは静的住所データとの連携実装
4. OpenStreetMap + GeoJSON 地図ビュー追加
5. 全市区町村データ対応（現在10件 → 1,700件以上）

## Phase3への拡張方針

1. `Municipality` 型のoptionalフィールド（`isolationIndex` 等）が既に定義済み
2. `src/lib/score.ts` の `calcOverallScore()` でweight調整可能
3. AIコメントは `aiComment` フィールドへの事前生成データ格納、または動的生成で対応

---

## Vercelデプロイ

```bash
npx vercel
```

または GitHubリポジトリをVercelに接続して自動デプロイ。
環境変数は現在不要（静的JSONのみ使用）。

---

## 注意事項

- 現在のデータはMVP用の仮データです
- 防災情報の最終確認は必ず自治体・国土交通省・消防庁等の公的機関の情報をご確認ください
- 本サービスの情報は防災意識向上を目的としており、正確性・完全性を保証するものではありません
