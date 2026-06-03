# 避難所充足偏差値 v1 仕様書

**UI表示名**: 避難所充足偏差値  
**内部名称**: shelter-sufficiency-v1  
**別称（補足）**: 防災偏差値（避難所ベース・暫定版）  
バージョン: v1（暫定版）  
作成日: 2026-06-03  
対象: `src/data/municipalities.json` スコアフィールド

> GSI指定避難所データと2020年国勢調査人口をもとに、人口1万人あたりの指定避難所数を全国比較した暫定指標です。

---

## 1. 目的

全国1,918市区町村の避難所整備状況を単一の偏差値スコアで比較可能にする。

- 住民が「自分の自治体がどの程度避難所を確保しているか」を直感的に把握できる
- 人口規模の差を正規化したうえで、避難所の整備状況を自治体間で公平に比較する
- 実データのみを使用し、推計・補完値によるスコア汚染を防ぐ

---

## 2. 非目的

- **総合的な防災力の評価ではない**: v1は避難所指標のみ。地震耐性・洪水対策・行政能力などは含まない
- **行政批判・政策評価ではない**: スコアは相対的な整備状況の可視化であり、自治体の努力・行政品質の評価ではない
- **人口の多さを不利評価しない**: 人口は正規化の分母であり、評価対象ではない
- **推計・補完データの使用**: 欠損値をゼロや平均で補完してスコア計算しない
- **順位の確定的公表**: v1はデータ整備中の暫定版。確定的なランキングとして公表しない

---

## 3. 使用データ

| データ | 取得元 | 件数 | バージョン |
|---|---|---|---|
| 指定避難所 | 国土地理院（GSI） 指定避難所CSV | 1,714自治体分 | shelter-v1 |
| 市区町村別総人口 | e-Stat 令和2年国勢調査 表1-1-1 | 1,908件 | population-v1 |
| 市区町村マスター | municipalities-base.json | 1,918件 | - |

**欠損の扱いは「8. 欠損処理」を参照。**

### データ制約

- 避難所データ: GSIデータ未提出/未確認の自治体（204件）は **スコア計算対象外**（`shelterCount=0` とみなさない）
- 人口データ: 既知欠損10件（北方領土6村・双葉町・浜松市新3区）はスコア計算対象外
- v1では収容人数（`capacity`）は指標に使用しない（データ欠損が多いため）

---

## 4. 使用指標

### 中核指標

| 指標名 | フィールド | 説明 |
|---|---|---|
| 人口1万人あたり指定避難所数 | `shelterCountPer10k` | v1スコアの唯一の計算基底 |

### 補助情報（スコア計算には使わない）

| 指標名 | フィールド | 説明 |
|---|---|---|
| 避難所数 | `shelterCount` | GSIから集計した指定避難所の数（null = データなし） |
| データ完全性 | `dataCompleteness` | 計算に使用したデータの揃い具合 |
| スコア信頼度 | `scoreConfidence` | スコアの信頼レベル |

---

## 5. 計算式

### shelterCountPer10k

```
shelterCountPer10k = (shelterCount / population) × 10,000
```

**計算可能条件:**
- `population` が正の整数（population-v1 から取得）
- `shelterCount` が0以上の整数（GSIデータが存在し、かつ集計値が確定している）

**計算不可条件（null を返す）:**
- `population` が欠損（既知10件）
- `population` が0以下
- GSIデータが未提出/未確認（`shelterCount = null`）

### shelterScore（偏差値）

```
shelterScore = max(10, min(90, round(50 + 10 × (x_clipped − μ) / σ)))
```

- `x_clipped`: Winsorization後の `shelterCountPer10k`
- `μ`: Winsorization後の値の平均（正規化対象集団）
- `σ`: 同標準偏差（母標準偏差）
- `round`: 小数第1位で四捨五入（整数）

**Winsorization（外れ値処理）の詳細は「6. 正規化方法」を参照。**

**計算不可条件（null を返す）:**
- `shelterCountPer10k` が null
- `scoreConfidence` が `"no-data"` または `"no-shelter-data"`

---

## 6. 正規化方法

### 正規化対象集団の定義

以下を **すべて満たす** 自治体のみを対象とする。

1. `population` が正の整数（population-v1 に存在する）
2. `shelterCount` が 0 以上の整数（GSIデータが存在し確定している）
3. `shelterCountPer10k` が計算可能（null でない）

GSIデータ未提出/未確認の自治体（`scoreConfidence = "no-shelter-data"`）は正規化対象から除外する。

### 正規化ステップ

| ステップ | 内容 |
|---|---|
| 1. 対象抽出 | 上記条件を満たす自治体の `shelterCountPer10k` 配列を作成 |
| 2. log1p 変換（任意） | 分布の歪みが強い場合に `log1p(shelterCountPer10k)` を適用。v1原則未使用。採用時は `calculationNotes` に記録 |
| 3. Winsorization | 上位・下位 **1%ile でクリッピング**（linear interpolation による percentile 算出） |
| 4. 平均・標準偏差算出 | クリッピング後の配列で μ・σ を算出 |
| 5. z-score 変換 | `(x_clipped − μ) / σ` |
| 6. 偏差値変換 | `50 + 10 × z` |
| 7. 丸め | `Math.round()` で整数化 |
| 8. クランプ | `max(10, min(90, score))` |

**正規化対象集団**: 計算可能な全自治体（全国比較）  
**都道府県別偏差値は v1 では生成しない**（全国統一スケール）

### Winsorization 詳細

```
percentile(arr, p):
  i = p / 100 × (arr.length - 1)   // linear interpolation
  lower = arr[Math.floor(i)]
  upper = arr[Math.ceil(i)]
  return lower + (upper - lower) × (i - Math.floor(i))

lower_bound = percentile(sorted_arr, 1)
upper_bound = percentile(sorted_arr, 99)
x_clipped   = max(lower_bound, min(upper_bound, x))
```

### log1p 変換について

v1では `shelterCountPer10k` を原則そのまま使用する。  
ただし実データ投入後の分布確認で **歪度が著しく大きい場合**（目安: skewness > 3）は、Winsorization 前に以下を適用してよい。

```
x = log1p(shelterCountPer10k)
```

採用した場合は `calculationNotes: "log1p applied before winsorization"` として記録する。

---

## 7. 偏差値変換方法

```
偏差値 = max(10, min(90, round(50 + 10 × (x_clipped − μ) / σ)))
```

| 偏差値帯 | 意味 | 目安 |
|---|---|---|
| 60以上 | 平均より充実 | 上位約16% |
| 50〜59 | 全国平均付近 | - |
| 40〜49 | 平均よりやや少ない | - |
| 39以下 | 平均より少ない | 下位約16% |

σ = 0（全自治体の値が同一）の場合は全自治体を50固定とする。

**クランプ範囲（10〜90）について**:  
スコアを10〜90にクランプするのは表示崩れ防止のための機械的処理であり、「偏差値10 = 最悪」「偏差値90 = 最良」という解釈ではない。クランプされた値の表示には注記を付けることを推奨する。

---

## 8. 欠損処理

### population欠損

- 対象: 既知10件（北方領土6村・双葉町・浜松市新3区）
- 処理: `shelterCountPer10k = null`、`shelterScore = null`
- `scoreConfidence = "no-data"`
- ランキング対象外（`nationalRank = null`、`prefectureRank = null`）

### GSIデータ未提出/未確認

- 対象: GSIからデータが提出されていない自治体（204件）
- 処理: `shelterCount = null`（0ではない）、`shelterCountPer10k = null`、`shelterScore = null`
- `scoreConfidence = "no-shelter-data"`
- **ランキング対象外**（`nationalRank = null`、`prefectureRank = null`）
- UI表示文言: 「GSI避難所データ未提出/未確認」

### GSIデータあり・shelterCount = 0

- 対象: GSIデータが存在し、かつ集計件数が実際に0の自治体
- 処理: `shelterCount = 0`、`shelterCountPer10k = 0.0`、`shelterScore` は計算値
- `scoreConfidence = "high"`（データは揃っており、整備件数が0という事実）
- ランキング対象（スコアは低く出る）

### 両方あり（通常ケース）

- `population > 0` かつ `shelterCount >= 0`（GSIデータ確定済み）
- `scoreConfidence = "high"`

### 整理表

| population | shelterData状態 | shelterCount | shelterCountPer10k | scoreConfidence | ランキング |
|---|---|---|---|---|---|
| あり | GSIデータあり (count > 0) | 正の整数 | 計算値 | `"high"` | 対象 |
| あり | GSIデータあり (count = 0) | 0 | 0.0 | `"high"` | 対象 |
| あり | GSIデータ未提出/未確認 | null | null | `"no-shelter-data"` | 対象外 |
| なし | どちらでも | 問わず | null | `"no-data"` | 対象外 |

---

## 9. ランキング生成ルール

### 全国ランキング

- 対象: `scoreConfidence = "high"` かつ `shelterScore !== null`
- 並び順: `shelterScore` 降順 → 同点時は `jisCode` 昇順
- フィールド: `nationalRank`（1始まり整数）

### 都道府県別ランキング

- 対象: 全国ランキングと同じ条件
- 並び順: 同上（都道府県内での相対順位）
- フィールド: `prefectureRank`（1始まり整数）

### ランキング対象外

- `scoreConfidence = "no-data"` または `"no-shelter-data"` の自治体は `nationalRank = null`、`prefectureRank = null`

### タイ処理

- 同スコアの複数自治体には同じ順位を与え、次の順位はスキップしない（dense rank）

---

## 10. municipalities.json 追加フィールド案

```typescript
{
  // --- 既存フィールド ---
  jisCode: string;
  prefecture: string;
  municipality: string;
  population: number | null;          // e-Stat 2020年国勢調査（1,908件。欠損10件はnull）
  populationSource: string | null;
  populationUpdatedAt: string | null;

  // --- v1 新規追加フィールド ---

  /**
   * 指定避難所数（GSI集計値）
   * - null: GSIデータ未提出/未確認
   * - 0:    GSIデータあり、集計値が0
   * - 正の整数: 集計値
   */
  shelterCount: number | null;

  /**
   * 人口1万人あたり指定避難所数
   * - null: population欠損 または shelterCount=null（GSIデータなし）
   */
  shelterCountPer10k: number | null;

  /**
   * 避難所充足偏差値（全国比較・Winsorization後）
   * - null: 計算不可（scoreConfidence が "no-data" または "no-shelter-data"）
   * - 範囲: 10〜90（クランプ済み。境界値は過剰解釈しないこと）
   */
  shelterScore: number | null;

  /** 全国ランキング順位（dense rank。対象外はnull） */
  nationalRank: number | null;

  /** 都道府県内ランキング順位（dense rank。対象外はnull） */
  prefectureRank: number | null;

  /**
   * データ完全性フラグ
   * - hasPopulation:  population-v1 データが存在する
   * - hasShelterData: GSI避難所データが存在する（件数0を含む）
   */
  dataCompleteness: {
    hasPopulation: boolean;
    hasShelterData: boolean;
  };

  /**
   * スコア信頼度
   * - "high":            population・shelter 両方あり（shelterCount=0 も含む）
   * - "no-shelter-data": population はあるが GSI避難所データ未提出/未確認
   * - "no-data":         population 欠損（スコア計算不可）
   */
  scoreConfidence: "high" | "no-shelter-data" | "no-data";

  /**
   * スコア計算バージョン
   * 将来の再計算・比較のためにバージョンを明記する
   */
  scoreVersion: "shelter-sufficiency-v1";

  /**
   * 計算上の特記事項（任意）
   * log1p 変換を適用した場合などに記録する
   * 例: "log1p applied before winsorization"
   */
  calculationNotes?: string;
}
```

### フィールド追加時の後方互換性

- 既存フィールド（`overallScore`・Phase3スコア群）はそのまま維持する
- v1 新規フィールドは独立して追加し、既存スコアを上書きしない
- `scoreVersion: "shelter-sufficiency-v1"` により将来の v2 と明確に区別する

---

## 付記: v1 の限界と v2 候補

| 限界 | v2 以降での対応候補 |
|---|---|
| 避難所指標のみ | 収容人数（`capacityPerPopulation`）追加 |
| GSI未提出を「データなし」として対象外 | 自治体オープンデータとのクロスチェックで補完 |
| 収容人数データ欠損が多い | 自治体個別アプローチで補完 |
| 高齢化率・地形リスクを考慮しない | 国勢調査・ハザードマップとの結合 |
| 分布が非正規（右裾が長い） | Box-Cox変換 または log1p 正規化後に偏差値変換 |
| "no-shelter-data" が多い（204件） | GSIへの自治体データ提出促進・代替データ収集 |
