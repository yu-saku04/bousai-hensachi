/**
 * score-aging-v1.ts
 *
 * 高齢化率（agingRate）から agingRisk 偏差値を計算し、
 * data/processed/aging.json を更新する。
 *
 * 設計:
 *   agingRate  = elderlyPopulation / population * 100
 *   winsorize  p1/p99（log1p なし）
 *   z-score    z = (rate_win - mean) / std
 *   agingRisk  = clamp(round(50 - 10 * z), 10, 90)
 *   ※ 高齢化率が高いほど agingRisk は低くなる（リスク高 = スコア低）
 *
 * Usage:
 *   tsx scripts/scoring/score-aging-v1.ts [--dry-run] [--output <path>]
 *
 *   --dry-run   統計のみ表示（デフォルト）
 *   --output    指定パスに aging.json を書き出す
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgingEntry {
  jisCode: string;
  elderlyPopulation: number;
  sourceUrl: string;
  updatedAt: string;
  calculationVersion: "aging-v1";
  agingRate?: number;
  agingRisk?: number;
  agingSource?: string;
  agingUpdatedAt?: string;
}

interface PopulationEntry {
  jisCode: string;
  population: number;
  calculationVersion: string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ROOT            = path.resolve(__dirname, "../../");
const AGING_PATH      = path.join(ROOT, "data/processed/aging.json");
const POPULATION_PATH = path.join(ROOT, "data/processed/population.json");

const AGING_SOURCE_URL = "https://www.e-stat.go.jp/stat-search/files?statdisp_id=0003445162";
// e-Stat 表2-7-1 の公表日（固定）。aging.json の updatedAt から流す設計とする。
const AGING_UPDATED_AT_FALLBACK = "2021-11-30";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(): { dryRun: boolean; outputPath: string | null } {
  const args = process.argv.slice(2);
  let dryRun     = true;
  let outputPath: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") {
      dryRun = true;
    } else if (args[i] === "--output") {
      outputPath = args[i + 1] ?? null;
      if (!outputPath || outputPath.startsWith("--")) {
        console.error("--output requires a path argument");
        process.exit(1);
      }
      i++;
      dryRun = false;
    }
  }
  return { dryRun, outputPath };
}

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  const i  = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function winsorize(values: number[], loPct: number, hiPct: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const lo     = percentile(sorted, loPct);
  const hi     = percentile(sorted, hiPct);
  return values.map((v) => Math.max(lo, Math.min(hi, v)));
}

function mean(arr: number[]): number {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stddev(arr: number[], mu: number): number {
  const variance = arr.reduce((s, v) => s + (v - mu) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function toAgingRisk(winsorizedRate: number, mu: number, sigma: number): number {
  if (sigma === 0) return 50;
  const z = (winsorizedRate - mu) / sigma;
  // 高齢化率が高い（z大）ほど agingRisk は低くなる
  return clamp(Math.round(50 - 10 * z), 10, 90);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const { dryRun, outputPath } = parseArgs();

  if (!fs.existsSync(AGING_PATH)) {
    console.error(`ERROR: aging.json が見つかりません: ${AGING_PATH}`);
    console.error(`  npm run import:aging を先に実行してください。`);
    process.exit(1);
  }
  if (!fs.existsSync(POPULATION_PATH)) {
    console.error(`ERROR: population.json が見つかりません: ${POPULATION_PATH}`);
    console.error(`  npm run import:population を先に実行してください。`);
    process.exit(1);
  }

  const agingData      = JSON.parse(fs.readFileSync(AGING_PATH,      "utf-8")) as AgingEntry[];
  const populationData = JSON.parse(fs.readFileSync(POPULATION_PATH, "utf-8")) as PopulationEntry[];

  // aging.json の updatedAt（import-aging 由来 = e-Stat 表2-7-1 公表日）を使用
  // 取得できない場合はフォールバック定数を使う
  const agingUpdatedAtFromData =
    (agingData[0]?.updatedAt) ?? AGING_UPDATED_AT_FALLBACK;
  const AGING_UPDATED_AT = agingUpdatedAtFromData;

  console.log(`aging.json:      ${agingData.length}件`);
  console.log(`population.json: ${populationData.length}件`);
  console.log(`agingUpdatedAt:  ${AGING_UPDATED_AT}`);

  // population を jisCode → population の Map に
  const popMap = new Map<string, number>();
  for (const p of populationData) {
    if (typeof p.population === "number" && p.population > 0) {
      popMap.set(p.jisCode, p.population);
    }
  }

  // ---------------------------------------------------------------------------
  // agingRate 計算（有効エントリの絞り込み）
  // ---------------------------------------------------------------------------

  interface ValidEntry {
    jisCode: string;
    agingRate: number;
  }

  const validEntries: ValidEntry[] = [];
  let skippedNoPopulation  = 0;
  let skippedInvalidRatio  = 0;

  for (const entry of agingData) {
    const population = popMap.get(entry.jisCode);
    if (population === undefined || population <= 0) {
      skippedNoPopulation++;
      continue;
    }
    const elderly = entry.elderlyPopulation;
    if (elderly > population) {
      console.warn(
        `  [${entry.jisCode}] elderlyPopulation(${elderly}) > population(${population}) → スキップ`,
      );
      skippedInvalidRatio++;
      continue;
    }
    const agingRate = (elderly / population) * 100;
    validEntries.push({ jisCode: entry.jisCode, agingRate });
  }

  if (validEntries.length === 0) {
    console.error("ERROR: スコア計算対象が0件です。データを確認してください。");
    process.exit(1);
  }

  console.log(`\nスコア計算対象: ${validEntries.length}件`);
  console.log(`  population欠損スキップ: ${skippedNoPopulation}件`);
  console.log(`  elderlyPopulation > population スキップ: ${skippedInvalidRatio}件`);

  // agingRate の統計
  const rates  = validEntries.map((e) => e.agingRate);
  const ratesSorted = [...rates].sort((a, b) => a - b);
  const rateMin = ratesSorted[0];
  const rateMax = ratesSorted[ratesSorted.length - 1];
  const rateMean = mean(rates);

  console.log(`\nagingRate 統計（winsorize前）:`);
  console.log(`  min:  ${rateMin.toFixed(2)}%`);
  console.log(`  max:  ${rateMax.toFixed(2)}%`);
  console.log(`  mean: ${rateMean.toFixed(2)}%`);
  console.log(`  p1:   ${percentile(ratesSorted, 1).toFixed(2)}%`);
  console.log(`  p99:  ${percentile(ratesSorted, 99).toFixed(2)}%`);

  // ---------------------------------------------------------------------------
  // Winsorize → z-score → agingRisk
  // ---------------------------------------------------------------------------

  const winsorized = winsorize(rates, 1, 99);
  const mu         = mean(winsorized);
  const sigma      = stddev(winsorized, mu);

  console.log(`\nWinsorize (p1/p99) 後:`);
  console.log(`  mean:  ${mu.toFixed(4)}`);
  console.log(`  std:   ${sigma.toFixed(4)}`);

  const riskValues: number[] = [];
  for (let i = 0; i < validEntries.length; i++) {
    riskValues.push(toAgingRisk(winsorized[i], mu, sigma));
  }

  const riskMin  = Math.min(...riskValues);
  const riskMax  = Math.max(...riskValues);
  const riskMean = mean(riskValues);

  console.log(`\nagingRisk 統計:`);
  console.log(`  min:  ${riskMin}`);
  console.log(`  max:  ${riskMax}`);
  console.log(`  mean: ${riskMean.toFixed(2)}`);
  console.log(`  clamp適用件数: ${riskValues.filter((v) => v === 10 || v === 90).length}件`);

  // ---------------------------------------------------------------------------
  // aging.json を更新（jisCode をキーに agingRate / agingRisk / agingSource / agingUpdatedAt を付与）
  // ---------------------------------------------------------------------------

  const riskMap = new Map<string, { agingRate: number; agingRisk: number }>();
  for (let i = 0; i < validEntries.length; i++) {
    riskMap.set(validEntries[i].jisCode, {
      agingRate: Math.round(validEntries[i].agingRate * 100) / 100, // 小数2桁
      agingRisk: riskValues[i],
    });
  }

  const updatedAging: AgingEntry[] = agingData.map((entry) => {
    const scored = riskMap.get(entry.jisCode);
    if (!scored) {
      // population欠損など対象外 → agingRate/agingRisk は付与しない
      return {
        ...entry,
        agingRate:      undefined,
        agingRisk:      undefined,
        agingSource:    undefined,
        agingUpdatedAt: undefined,
      };
    }
    return {
      ...entry,
      agingRate:      scored.agingRate,
      agingRisk:      scored.agingRisk,
      agingSource:    AGING_SOURCE_URL,
      agingUpdatedAt: AGING_UPDATED_AT,
    };
  });

  // ---------------------------------------------------------------------------
  // 異常値チェック
  // ---------------------------------------------------------------------------

  const anomalies = updatedAging.filter(
    (e) =>
      e.agingRisk !== undefined &&
      (e.agingRisk < 10 || e.agingRisk > 90 || !Number.isInteger(e.agingRisk)),
  );
  if (anomalies.length > 0) {
    console.warn(`\n⚠️ agingRisk 異常値: ${anomalies.length}件`);
    for (const a of anomalies.slice(0, 5)) {
      console.warn(`  ${a.jisCode}: agingRisk=${a.agingRisk}`);
    }
  } else {
    console.log(`\n異常値: なし ✅`);
  }

  // ---------------------------------------------------------------------------
  // 先頭5件プレビュー
  // ---------------------------------------------------------------------------

  console.log(`\n先頭5件プレビュー:`);
  updatedAging.slice(0, 5).forEach((e) => {
    const { jisCode, elderlyPopulation, agingRate, agingRisk, agingSource, agingUpdatedAt, calculationVersion } = e;
    console.log(`  ${JSON.stringify({ jisCode, elderlyPopulation, agingRate, agingRisk, agingSource, agingUpdatedAt, calculationVersion })}`);
  });

  // ---------------------------------------------------------------------------
  // 書き出し
  // ---------------------------------------------------------------------------

  if (dryRun) {
    console.log(`\n[dry-run] ファイルは書き出しません。`);
    console.log(`  --output data/processed/aging.json を指定して本番実行してください。`);
    return;
  }

  const writePath = outputPath ?? AGING_PATH;
  fs.mkdirSync(path.dirname(writePath), { recursive: true });
  fs.writeFileSync(writePath, JSON.stringify(updatedAging, null, 2), "utf-8");
  console.log(`\n✅ 書き出し完了: ${writePath} (${updatedAging.length}件)`);
}

main();
