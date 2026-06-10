/**
 * score-overall-v2.ts — overallScoreV2 dry-run
 *
 * 現行 overallScore は変更せず、新しい overallScoreV2 を試算する。
 *
 * カテゴリ（全て 0〜100 スケール、高いほど安全）:
 *   Hazard              (weight 0.40): earthquakeRisk
 *   Infrastructure      (weight 0.30): shelterScore (shelter-sufficiency-v1) ?? shelterCapacity
 *   Social Vulnerability (weight 0.30): mean(agingRisk, householdRisk)
 *   Accessibility       (weight 0.00): 将来追加
 *
 * カテゴリが null の場合は残りカテゴリの重みで再正規化（null-safe weighted average）。
 * 最終値は clamp(round(weighted_avg), 10, 90)。
 *
 * Usage:
 *   tsx scripts/scoring/score-overall-v2.ts [--output PATH]
 *   --output PATH   municipalities.json に overallScoreV2 を書き出す
 *   (省略時は dry-run: 統計のみ表示)
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CALCULATION_VERSION = "v2-dryrun-1" as const;

const CATEGORY_WEIGHTS = {
  hazard:        0.40,
  infra:         0.30,
  social:        0.30,
  accessibility: 0.00, // 将来追加
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MunicipalityRow {
  id: string;
  jisCode?: string;
  overallScore: number;
  earthquakeRisk?: number;
  shelterScore?: number | null;
  shelterCapacity?: number;
  agingRisk?: number;
  householdRisk?: number;
  overallScoreV2?: number | null;
  overallScoreV2Version?: string;
  [key: string]: unknown;
}

interface CategoryBreakdown {
  hazardScore:  number | null;
  infraScore:   number | null;
  socialScore:  number | null;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(): { dryRun: boolean; outputPath: string } {
  const args = process.argv.slice(2);
  const DEFAULT_OUTPUT = path.resolve(__dirname, "../../src/data/municipalities.json");

  let dryRun     = true;
  let outputPath = DEFAULT_OUTPUT;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") {
      dryRun = true;
    } else if (args[i] === "--output") {
      const p = args[i + 1];
      if (!p || p.startsWith("--")) {
        console.error("--output requires a path argument");
        process.exit(1);
      }
      outputPath = path.resolve(p);
      dryRun     = false;
      i++;
    }
  }
  return { dryRun, outputPath };
}

// ---------------------------------------------------------------------------
// Core computation
// ---------------------------------------------------------------------------

export function computeOverallScoreV2(m: MunicipalityRow): {
  score: number | null;
  breakdown: CategoryBreakdown;
} {
  // Hazard: earthquakeRisk（単一指標、将来追加予定）
  const hazardScore =
    typeof m.earthquakeRisk === "number" && !isNaN(m.earthquakeRisk)
      ? m.earthquakeRisk
      : null;

  // Infrastructure: shelterScore (shelter-sufficiency-v1) → shelterCapacity (fallback)
  const rawInfra =
    (typeof m.shelterScore === "number" && m.shelterScore !== null && !isNaN(m.shelterScore))
      ? m.shelterScore
      : (typeof m.shelterCapacity === "number" && !isNaN(m.shelterCapacity))
        ? m.shelterCapacity
        : null;
  const infraScore = rawInfra !== null ? Math.max(0, Math.min(100, rawInfra)) : null;

  // Social Vulnerability: mean(agingRisk, householdRisk)
  const aging     = typeof m.agingRisk     === "number" && !isNaN(m.agingRisk)     ? m.agingRisk     : null;
  const household = typeof m.householdRisk === "number" && !isNaN(m.householdRisk) ? m.householdRisk : null;
  const socialScore =
    aging !== null && household !== null ? Math.round((aging + household) / 2) :
    aging !== null                       ? aging :
    household !== null                   ? household :
    null;

  // Null-safe weighted average
  const categories: Array<{ score: number; weight: number }> = [];
  if (hazardScore !== null) categories.push({ score: hazardScore, weight: CATEGORY_WEIGHTS.hazard });
  if (infraScore  !== null) categories.push({ score: infraScore,  weight: CATEGORY_WEIGHTS.infra  });
  if (socialScore !== null) categories.push({ score: socialScore, weight: CATEGORY_WEIGHTS.social });

  if (categories.length === 0) {
    return { score: null, breakdown: { hazardScore, infraScore, socialScore } };
  }

  const weightedSum = categories.reduce((acc, c) => acc + c.score  * c.weight, 0);
  const totalWeight = categories.reduce((acc, c) => acc + c.weight, 0);
  const score = Math.max(10, Math.min(90, Math.round(weightedSum / totalWeight)));

  return { score, breakdown: { hazardScore, infraScore, socialScore } };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const { dryRun, outputPath } = parseArgs();

  const inputPath = path.resolve(__dirname, "../../src/data/municipalities.json");
  if (!fs.existsSync(inputPath)) {
    console.error(`municipalities.json が見つかりません: ${inputPath}`);
    process.exit(1);
  }

  const data: MunicipalityRow[] = JSON.parse(fs.readFileSync(inputPath, "utf-8"));
  console.log(`読み込み: ${inputPath} (${data.length}件)\n`);

  // ---------------------------------------------------------------------------
  // 計算
  // ---------------------------------------------------------------------------

  let nullCount          = 0;
  let shelterScoreUsed   = 0;
  let shelterCapacityUsed = 0;
  let socialBothUsed     = 0;
  let socialPartialUsed  = 0;
  const v2Scores: number[] = [];

  const updated = data.map((m) => {
    const { score, breakdown } = computeOverallScoreV2(m);

    if (score === null) {
      nullCount++;
    } else {
      v2Scores.push(score);
    }

    // Infrastructure ソース集計
    if (typeof m.shelterScore === "number" && m.shelterScore !== null) {
      shelterScoreUsed++;
    } else if (typeof m.shelterCapacity === "number") {
      shelterCapacityUsed++;
    }

    // Social Vulnerability ソース集計
    const hasAging     = typeof m.agingRisk     === "number";
    const hasHousehold = typeof m.householdRisk === "number";
    if (hasAging && hasHousehold) socialBothUsed++;
    else if (hasAging || hasHousehold) socialPartialUsed++;

    // overallScore は変更しない
    const result: MunicipalityRow = { ...m };
    result.overallScoreV2        = score;
    result.overallScoreV2Version = CALCULATION_VERSION;

    // unused breakdown warning suppression (breakdown is used in stats only)
    void breakdown;

    return result;
  });

  // ---------------------------------------------------------------------------
  // 統計
  // ---------------------------------------------------------------------------

  console.log("=== overallScoreV2 dry-run 統計 ===\n");
  console.log(`calculationVersion : ${CALCULATION_VERSION}`);
  console.log(`対象自治体         : ${data.length}件`);
  console.log(`overallScoreV2算出 : ${v2Scores.length}件`);
  console.log(`overallScoreV2=null: ${nullCount}件\n`);

  console.log("カテゴリ別ソース:");
  console.log(`  Hazard           : earthquakeRisk (${data.filter((m) => typeof m.earthquakeRisk === "number").length}件)`);
  console.log(`  Infrastructure   : shelterScore=${shelterScoreUsed}件 / shelterCapacity(fallback)=${shelterCapacityUsed}件`);
  console.log(`  Social           : both(aging+household)=${socialBothUsed}件 / partial=${socialPartialUsed}件`);

  if (v2Scores.length > 0) {
    const min  = Math.min(...v2Scores);
    const max  = Math.max(...v2Scores);
    const mean = v2Scores.reduce((a, b) => a + b, 0) / v2Scores.length;
    console.log(`\noverallScoreV2 統計:`);
    console.log(`  min  : ${min}`);
    console.log(`  max  : ${max}`);
    console.log(`  mean : ${mean.toFixed(2)}`);

    // overallScore との差分
    const diffs = updated
      .filter((m) => typeof m.overallScoreV2 === "number" && typeof m.overallScore === "number")
      .map((m) => (m.overallScoreV2 as number) - m.overallScore);
    const diffMean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    const diffMax  = Math.max(...diffs.map(Math.abs));
    console.log(`\noverallScoreV2 - overallScore:`);
    console.log(`  mean diff : ${diffMean.toFixed(2)}`);
    console.log(`  max |diff|: ${diffMax}`);
  }

  // 先頭5件プレビュー
  console.log("\n先頭5件プレビュー:");
  updated.slice(0, 5).forEach((m) => {
    const { id, overallScore, overallScoreV2, earthquakeRisk, shelterCapacity, agingRisk, householdRisk } = m;
    console.log(`  [${m.jisCode ?? id}] overallScore=${overallScore} → v2=${overallScoreV2} | eq=${earthquakeRisk} shelter=${shelterCapacity} aging=${agingRisk} household=${householdRisk}`);
  });

  // ---------------------------------------------------------------------------
  // 書き出し
  // ---------------------------------------------------------------------------

  if (dryRun) {
    console.log(`\n[dry-run] ファイルは書き出しません。`);
    console.log(`  --output src/data/municipalities.json を指定して本番実行してください。`);
    return;
  }

  fs.writeFileSync(outputPath, JSON.stringify(updated, null, 2), "utf-8");
  console.log(`\n✅ 書き出し完了: ${outputPath} (${updated.length}件)`);
  console.log(`   overallScore は変更されていません。`);
}

if (require.main === module) {
  main();
}
