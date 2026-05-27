/**
 * スコア正規化ユーティリティ
 *
 * 省庁オープンデータの生値（人口・火災件数・浸水深等）を
 * 0〜100の防災スコアへ変換する関数群。
 *
 * 変換の方向性：
 *  - すべての出力スコアで「高い = 安全・良い」に統一
 *  - 浸水深など「低いほど安全」な指標は normalizeLowerIsBetter を使用
 *  - 避難所収容率など「高いほど良い」指標は normalizeHigherIsBetter を使用
 */

/** 0〜100 にクランプして整数化 */
function clamp100(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v)));
}

/**
 * 高いほど良い指標を 0〜100 に線形正規化する。
 * 例: 避難所収容率、消防力密度
 *
 * @param value  対象の生値
 * @param min    データセット内の最小値（またはドメイン下限）
 * @param max    データセット内の最大値（またはドメイン上限）
 */
export function normalizeHigherIsBetter(
  value: number,
  min: number,
  max: number
): number {
  if (max <= min) return 50;
  const clamped = Math.max(min, Math.min(max, value));
  return clamp100(((clamped - min) / (max - min)) * 100);
}

/**
 * 低いほど良い指標を 0〜100 に線形正規化する（反転）。
 * 例: 浸水深、火災発生率、高齢化率
 *
 * @param value  対象の生値
 * @param min    データセット内の最小値（またはドメイン下限）
 * @param max    データセット内の最大値（またはドメイン上限）
 */
export function normalizeLowerIsBetter(
  value: number,
  min: number,
  max: number
): number {
  if (max <= min) return 50;
  const clamped = Math.max(min, Math.min(max, value));
  return clamp100(((max - clamped) / (max - min)) * 100);
}

/**
 * データセット内でのパーセンタイル順位を 0〜100 スコアに変換する。
 * 「高いほど良い」前提。低いほど良い場合は事前に反転すること。
 *
 * 例: 全市区町村の避難所収容率データ配列から自市のパーセンタイルを算出
 *
 * @param value    対象の生値
 * @param dataset  比較対象の全データポイント（対象値を含む）
 */
export function calculatePercentileScore(
  value: number,
  dataset: number[]
): number {
  if (dataset.length === 0) return 50;
  const below = dataset.filter((v) => v < value).length;
  const equal = dataset.filter((v) => v === value).length;
  // 中間パーセンタイル方式: (below + 0.5 * equal) / n
  return clamp100(((below + 0.5 * equal) / dataset.length) * 100);
}

/**
 * 統計的偏差スコアを算出する（平均50・標準偏差σ基準）。
 * z スコアを [-3σ, +3σ] にクランプして [0, 100] にマッピング。
 *
 * 例: 地震リスクの都道府県内偏差、火災件数の全国偏差
 *
 * @param value   対象の生値
 * @param mean    母集団の平均
 * @param stdDev  母集団の標準偏差
 * @param higherIsBetter true = 値が大きいほどスコアが高い（デフォルト: true）
 */
export function calculateDeviationScore(
  value: number,
  mean: number,
  stdDev: number,
  higherIsBetter = true
): number {
  if (stdDev <= 0) return 50;
  const z = (value - mean) / stdDev;
  const clamped = Math.max(-3, Math.min(3, z));
  const raw = 50 + (clamped / 3) * 50;
  return clamp100(higherIsBetter ? raw : 100 - raw);
}

/**
 * 複数スコアを重み付き平均して統合スコアを算出する。
 * undefined のスコアは重みから除外する。
 *
 * @param items  { score: number | undefined, weight: number }[] の配列
 */
export function weightedAverage(
  items: Array<{ score: number | undefined; weight: number }>
): number {
  let total = 0;
  let weightSum = 0;
  for (const { score, weight } of items) {
    if (typeof score === "number" && !isNaN(score)) {
      total += clamp100(score) * weight;
      weightSum += weight;
    }
  }
  if (weightSum === 0) return 0;
  return clamp100(total / weightSum);
}

/**
 * 避難所データから shelterCapacity スコア（0〜100）を算出する。
 *
 * 優先順位:
 *   1. sheltersPerTenThousand がある場合: 全自治体のパーセンタイル順位でスコア化
 *   2. すべて null の場合: totalCapacity のパーセンタイル順位にフォールバック
 *
 * @param sheltersPerTenThousand  対象自治体の人口1万人あたり避難所数（人口未取得の場合 null）
 * @param dataset                 全自治体の sheltersPerTenThousand（null 含む）
 * @param totalCapacityFallback   人口データなし時のフォールバック値（総収容人数）
 * @param totalCapacityDataset    フォールバック用の全データセット
 */
export function calcShelterCapacityScore(
  sheltersPerTenThousand: number | null,
  dataset: Array<number | null>,
  totalCapacityFallback: number,
  totalCapacityDataset: number[],
): number {
  const validPerTenK = dataset.filter((v): v is number => v !== null);
  if (sheltersPerTenThousand !== null && validPerTenK.length > 0) {
    return calculatePercentileScore(sheltersPerTenThousand, validPerTenK);
  }
  if (totalCapacityDataset.length > 0) {
    return calculatePercentileScore(totalCapacityFallback, totalCapacityDataset);
  }
  return 50;
}

/**
 * 標準偏差を算出するユーティリティ（母標準偏差）。
 */
export function stdDev(dataset: number[]): number {
  if (dataset.length === 0) return 0;
  const mean = dataset.reduce((a, b) => a + b, 0) / dataset.length;
  const variance =
    dataset.reduce((sum, v) => sum + (v - mean) ** 2, 0) / dataset.length;
  return Math.sqrt(variance);
}
