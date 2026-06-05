# overallScore v2 仕様書

## 1. 目的

既存の `overallScore` は後方互換性のため変更しない。

`overallScoreV2` を新設し、カテゴリ別スコアを重み付け統合する方式で算出する。
v2 は v1 と並存し、段階的に実データが整い次第 v2 への移行を検討する。

---

## 2. 既存 overallScore との関係

| フィールド | 説明 |
|---|---|
| `overallScore` | 既存互換。変更しない。 |
| `overallScoreV2` | 新設。カテゴリ別重み付き平均。 |
| `overallScoreVersion` | `"overall-v2"` を設定。 |

> **注**: `scoreVersion` は `shelter-sufficiency-v1` で既に使用中のため流用しない。

---

## 3. カテゴリ設計

v2 では指標を4カテゴリに分類する。

### Hazard（自然災害危険度）
- `floodRisk`
- `earthquakeRisk`
- `fireRisk`

### Infrastructure（防災インフラ）
- `shelterScore`

### Social Vulnerability（社会的脆弱性）
- `agingRisk`
- `householdRisk`
- `childcareStressRisk` → **実データ化まで除外**

### Accessibility（孤立・アクセシビリティ）
- `isolationRisk`

---

## 4. 初期v2重み案

| カテゴリ | 初期重み |
|---|---|
| Hazard | 0.40 |
| Infrastructure | 0.25 |
| Social Vulnerability | 0.25 |
| Accessibility | 0.10 |

### 将来の重み再検討条件

`isolationRisk` が実データ化された段階で以下に再検討する:

| カテゴリ | 再検討後重み |
|---|---|
| Hazard | 0.35 |
| Infrastructure | 0.25 |
| Social Vulnerability | 0.25 |
| Accessibility | 0.15 |

---

## 5. 指標分類

各指標を以下の4種に分類する。

| 種別 | 定義 |
|---|---|
| `real` | 実統計データから算出 |
| `provisional` | 初期値・推計・仮値 |
| `derived` | 他指標から二次算出 |
| `neutralFallback` | 欠損時の中立値（50）代入 |

### 現時点の分類

| 指標 | 種別 | 備考 |
|---|---|---|
| `shelterScore` | real | GSI避難所データ + 国勢調査人口 |
| `agingRisk` | real | e-Stat 国勢調査 2020 表2-7-1 |
| `householdRisk` | real | e-Stat 国勢調査 2020 表9-1-1 |
| `floodRisk` | provisional | 実データ化予定 |
| `earthquakeRisk` | provisional | 実データ化予定 |
| `fireRisk` | provisional | 実データ化予定 |
| `isolationRisk` | provisional | 実データ化予定 |
| `childcareStressRisk` | provisional | v2から除外 |

---

## 6. categoryScores 構造案

`Municipality` 型に追加するカテゴリ別スコアフィールド:

```typescript
categoryScores?: {
  hazard?: number;             // 10〜90 整数
  infrastructure?: number;     // 10〜90 整数
  socialVulnerability?: number; // 10〜90 整数
  accessibility?: number;      // 10〜90 整数
};
```

各カテゴリスコアはカテゴリ内指標の単純平均（整数に丸め）。

---

## 7. scoreDataQuality 構造案

```typescript
scoreDataQuality?: {
  realMetricCount: number;        // 実データ指標数
  provisionalMetricCount: number; // 暫定指標数
  missingCategoryCount: number;   // スコア算出不能カテゴリ数
  neutralFallbackCount: number;   // neutralFallback 適用指標数
};
```

UI でデータ品質を可視化する際に参照する。

---

## 8. v2 計算方針

1. **カテゴリ内平均**: カテゴリ内の指標を単純平均してカテゴリスコアを算出
2. **childcareStressRisk は v2 除外**: 実データ化後に Social Vulnerability へ追加
3. **missing カテゴリの重み再配分**: カテゴリが算出不能の場合、残りカテゴリに按分
4. **dataQuality への反映**: provisional 指標が混入する場合は `scoreDataQuality` に記録
5. **householdRisk の位置付け**: Social Vulnerability カテゴリに含める
6. **agingRisk と householdRisk の重複緩和**: カテゴリ内平均により、同一カテゴリの2指標は自動的に重みが等分される

### 計算式（疑似コード）

```
categoryHazard = mean([floodRisk, earthquakeRisk, fireRisk])
categoryInfra  = shelterScore
categorySocial = mean([agingRisk, householdRisk])   // childcareStressRisk は除外
categoryAccess = isolationRisk

// missingカテゴリがある場合: 有効カテゴリで重み再配分
effectiveWeights = redistribute(baseWeights, missingCategories)

overallScoreV2 = clamp(round(
  categoryHazard * effectiveWeights.hazard +
  categoryInfra  * effectiveWeights.infrastructure +
  categorySocial * effectiveWeights.socialVulnerability +
  categoryAccess * effectiveWeights.accessibility
), 10, 90)
```

---

## 9. 実装をまだ行わない理由

現時点で v2 を実装しない理由:

1. **hazard 系が未実データ**: `floodRisk` / `earthquakeRisk` / `fireRisk` が provisional のまま v2 を算出しても信頼性が低い
2. **次の優先作業**: `floodRisk` 実データ化を先行させる
3. **dry-run の意味**: `floodRisk` 実データ化後に v2 dry-run で各カテゴリスコア・重みを検証してから正式実装とする

---

## 10. validation 方針

v2 実装後に `validate-datasets.ts` へ追加するチェック:

| チェック | 内容 |
|---|---|
| categoryScores 再計算一致 | 格納値と算出値の差が ±1 以内 |
| 重み合計チェック | effectiveWeights の合計が 1.0 |
| 指標分類チェック | 各指標の種別が仕様と一致 |
| provisional 混入チェック | `scoreDataQuality.provisionalMetricCount` が記録されていること |
| missing 時の重み再配分チェック | missing カテゴリが存在するとき effectiveWeights が正規化されていること |
| overallScoreV2 範囲チェック | 10〜90 整数 |

---

## 11. UI 注記方針

- `overallScore` と `overallScoreV2` を混同しない（別フィールド・別表示）
- v2 は「試験版」または「β」と明示する
- 使用指標の一覧と実データ率（real / 全指標数）を表示する

```
例: データ品質 3/6指標が実データ（50%）
    [real] 避難所スコア・高齢化リスク・世帯構成リスク
    [暫定] 洪水・地震・火災
```

---

## 12. 次フェーズ

### 直近優先: floodRisk 実データ化調査

- 洪水データ候補（国土交通省・国土数値情報・e-Stat 等）の特定
- 市区町村粒度でのカバレッジ確認
- 算出式・偏差値化方針の検討
- statsDataId / ファイル URL / 更新日の確認

### その後

- `floodRisk` 実データ化 → `earthquakeRisk` → `fireRisk` の順に実データ化
- hazard 系3指標が real になった段階で v2 dry-run 実施
- dry-run 結果を確認して v2 正式実装
