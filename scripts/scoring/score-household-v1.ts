/**
 * score-household-v1.ts
 *
 * elderlySingleRate（高齢単身世帯率）から householdRisk 偏差値を計算し、
 * data/processed/household.json を更新する。
 *
 * 設計:
 *   elderlySingleRate  = elderlySingleHouseholds / totalGeneralHouseholds * 100
 *   elderlyCoupleRate  = elderlyCoupleHouseholds / totalGeneralHouseholds * 100
 *   winsorize  p1/p99（log1p なし）
 *   z-score    z = (rate_win - mean) / std
 *   householdRisk = clamp(round(50 - 10 * z), 10, 90)
 *   ※ 高齢単身世帯率が高いほど householdRisk は低くなる（リスク高 = スコア低）
 *
 * Usage:
 *   tsx scripts/scoring/score-household-v1.ts [--dry-run] [--output <path>]
 *
 *   --dry-run   統計のみ表示（デフォルト）
 *   --output    指定パスに household.json を書き出す
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HouseholdEntry {
  jisCode: string;
  totalGeneralHouseholds: number;
  elderlySingleHouseholds: number;
  elderlyCoupleHouseholds: number;
  calculationVersion: "household-v1";
  elderlySingleRate?: number;
  elderlyCoupleRate?: number;
  householdRisk?: number;
  householdSource?: string;
  householdUpdatedAt?: string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ROOT             = path.resolve(__dirname, "../../");
const HOUSEHOLD_PATH   = path.join(ROOT, "data/processed/household.json");

const HOUSEHOLD_SOURCE_URL = "https://www.e-stat.go.jp/stat-search/files?statdisp_id=0003445284";
const HOUSEHOLD_UPDATED_AT = "2021-11-30";

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

function toHouseholdRisk(winsorizedRate: number, mu: number, sigma: number): number {
  if (sigma === 0) return 50;
  const z = (winsorizedRate - mu) / sigma;
  // 高齢単身世帯率が高い（z大）ほど householdRisk は低くなる
  return clamp(Math.round(50 - 10 * z), 10, 90);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const { dryRun, outputPath } = parseArgs();

  if (!fs.existsSync(HOUSEHOLD_PATH)) {
    console.error(`ERROR: household.json が見つかりません: ${HOUSEHOLD_PATH}`);
    console.error(`  npm run import:household を先に実行してください。`);
    process.exit(1);
  }

  const householdData = JSON.parse(fs.readFileSync(HOUSEHOLD_PATH, "utf-8")) as HouseholdEntry[];

  console.log(`household.json: ${householdData.length}件`);

  // ---------------------------------------------------------------------------
  // 有効エントリの絞り込み
  // ---------------------------------------------------------------------------

  interface ValidEntry {
    jisCode: string;
    elderlySingleRate: number;
    elderlyCoupleRate: number;
  }

  const validEntries: ValidEntry[] = [];
  let skippedZeroTotal   = 0;
  let skippedInvalidSingle = 0;
  let skippedInvalidCouple = 0;

  for (const entry of householdData) {
    const total  = entry.totalGeneralHouseholds;
    const single = entry.elderlySingleHouseholds;
    const couple = entry.elderlyCoupleHouseholds;

    if (typeof total !== "number" || total <= 0) {
      skippedZeroTotal++;
      continue;
    }
    if (single > total) {
      console.warn(
        `  [${entry.jisCode}] elderlySingleHouseholds(${single}) > total(${total}) → スキップ`,
      );
      skippedInvalidSingle++;
      continue;
    }
    if (couple > total) {
      console.warn(
        `  [${entry.jisCode}] elderlyCoupleHouseholds(${couple}) > total(${total}) → スキップ`,
      );
      skippedInvalidCouple++;
      continue;
    }

    validEntries.push({
      jisCode:           entry.jisCode,
      elderlySingleRate: (single / total) * 100,
      elderlyCoupleRate: (couple / total) * 100,
    });
  }

  if (validEntries.length === 0) {
    console.error("ERROR: スコア計算対象が0件です。データを確認してください。");
    process.exit(1);
  }

  console.log(`\nスコア計算対象: ${validEntries.length}件`);
  console.log(`  totalGeneralHouseholds=0 スキップ: ${skippedZeroTotal}件`);
  console.log(`  elderlySingleHouseholds > total スキップ: ${skippedInvalidSingle}件`);
  console.log(`  elderlyCoupleHouseholds > total スキップ: ${skippedInvalidCouple}件`);

  // elderlySingleRate の統計
  const singleRates       = validEntries.map((e) => e.elderlySingleRate);
  const singleRatesSorted = [...singleRates].sort((a, b) => a - b);
  const singleRateMin     = singleRatesSorted[0];
  const singleRateMax     = singleRatesSorted[singleRatesSorted.length - 1];
  const singleRateMean    = mean(singleRates);

  console.log(`\nelderlySingleRate 統計（winsorize前）:`);
  console.log(`  min:  ${singleRateMin.toFixed(2)}%`);
  console.log(`  max:  ${singleRateMax.toFixed(2)}%`);
  console.log(`  mean: ${singleRateMean.toFixed(2)}%`);
  console.log(`  p1:   ${percentile(singleRatesSorted, 1).toFixed(2)}%`);
  console.log(`  p99:  ${percentile(singleRatesSorted, 99).toFixed(2)}%`);

  // elderlyCoupleRate の統計（参考）
  const coupleRates    = validEntries.map((e) => e.elderlyCoupleRate);
  const coupleRateSorted = [...coupleRates].sort((a, b) => a - b);
  console.log(`\nelderlyCoupleRate 統計（参考）:`);
  console.log(`  min:  ${coupleRateSorted[0].toFixed(2)}%`);
  console.log(`  max:  ${coupleRateSorted[coupleRateSorted.length - 1].toFixed(2)}%`);
  console.log(`  mean: ${mean(coupleRates).toFixed(2)}%`);

  // ---------------------------------------------------------------------------
  // Winsorize → z-score → householdRisk（elderlySingleRate を主指標）
  // ---------------------------------------------------------------------------

  const winsorized = winsorize(singleRates, 1, 99);
  const mu         = mean(winsorized);
  const sigma      = stddev(winsorized, mu);

  console.log(`\nWinsorize (p1/p99) 後:`);
  console.log(`  mean:  ${mu.toFixed(4)}`);
  console.log(`  std:   ${sigma.toFixed(4)}`);

  const riskValues: number[] = [];
  for (let i = 0; i < validEntries.length; i++) {
    riskValues.push(toHouseholdRisk(winsorized[i], mu, sigma));
  }

  const riskMin  = Math.min(...riskValues);
  const riskMax  = Math.max(...riskValues);
  const riskMean = mean(riskValues);

  console.log(`\nhouseholdRisk 統計:`);
  console.log(`  min:  ${riskMin}`);
  console.log(`  max:  ${riskMax}`);
  console.log(`  mean: ${riskMean.toFixed(2)}`);
  console.log(`  clamp適用件数: ${riskValues.filter((v) => v === 10 || v === 90).length}件`);

  // ---------------------------------------------------------------------------
  // household.json を更新
  // ---------------------------------------------------------------------------

  const riskMap = new Map<string, {
    elderlySingleRate: number;
    elderlyCoupleRate: number;
    householdRisk: number;
  }>();
  for (let i = 0; i < validEntries.length; i++) {
    riskMap.set(validEntries[i].jisCode, {
      elderlySingleRate: Math.round(validEntries[i].elderlySingleRate * 100) / 100,
      elderlyCoupleRate: Math.round(validEntries[i].elderlyCoupleRate * 100) / 100,
      householdRisk:     riskValues[i],
    });
  }

  const updated: HouseholdEntry[] = householdData.map((entry) => {
    const scored = riskMap.get(entry.jisCode);
    if (!scored) {
      return {
        ...entry,
        elderlySingleRate:  undefined,
        elderlyCoupleRate:  undefined,
        householdRisk:      undefined,
        householdSource:    undefined,
        householdUpdatedAt: undefined,
      };
    }
    return {
      ...entry,
      elderlySingleRate:  scored.elderlySingleRate,
      elderlyCoupleRate:  scored.elderlyCoupleRate,
      householdRisk:      scored.householdRisk,
      householdSource:    HOUSEHOLD_SOURCE_URL,
      householdUpdatedAt: HOUSEHOLD_UPDATED_AT,
    };
  });

  // ---------------------------------------------------------------------------
  // 異常値チェック
  // ---------------------------------------------------------------------------

  const anomalies = updated.filter(
    (e) =>
      e.householdRisk !== undefined &&
      (e.householdRisk < 10 || e.householdRisk > 90 || !Number.isInteger(e.householdRisk)),
  );
  if (anomalies.length > 0) {
    console.warn(`\n⚠️ householdRisk 異常値: ${anomalies.length}件`);
    for (const a of anomalies.slice(0, 5)) {
      console.warn(`  ${a.jisCode}: householdRisk=${a.householdRisk}`);
    }
  } else {
    console.log(`\n異常値: なし ✅`);
  }

  // ---------------------------------------------------------------------------
  // 先頭5件プレビュー
  // ---------------------------------------------------------------------------

  console.log(`\n先頭5件プレビュー:`);
  updated.slice(0, 5).forEach((e) => {
    const {
      jisCode, totalGeneralHouseholds, elderlySingleHouseholds, elderlyCoupleHouseholds,
      elderlySingleRate, elderlyCoupleRate, householdRisk, householdUpdatedAt, calculationVersion,
    } = e;
    console.log(`  ${JSON.stringify({
      jisCode, totalGeneralHouseholds, elderlySingleHouseholds, elderlyCoupleHouseholds,
      elderlySingleRate, elderlyCoupleRate, householdRisk, householdUpdatedAt, calculationVersion,
    })}`);
  });

  // ---------------------------------------------------------------------------
  // 書き出し
  // ---------------------------------------------------------------------------

  if (dryRun) {
    console.log(`\n[dry-run] ファイルは書き出しません。`);
    console.log(`  --output data/processed/household.json を指定して本番実行してください。`);
    return;
  }

  const writePath = outputPath ?? HOUSEHOLD_PATH;
  fs.mkdirSync(path.dirname(writePath), { recursive: true });
  fs.writeFileSync(writePath, JSON.stringify(updated, null, 2), "utf-8");
  console.log(`\n✅ 書き出し完了: ${writePath} (${updated.length}件)`);
}

main();
