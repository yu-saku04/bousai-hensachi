/**
 * analyze-overall-v2-diff.ts
 *
 * overallScore と overallScoreV2 の差分分析レポートを生成する。
 * municipalities.json は変更しない。
 *
 * 出力: data/analysis/overall-v2-diff-summary.json
 *
 * Usage:
 *   tsx scripts/analysis/analyze-overall-v2-diff.ts [--input PATH] [--output PATH]
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MunicipalityRow {
  id: string;
  jisCode?: string;
  prefecture: string;
  municipality: string;
  overallScore: number;
  overallScoreV2?: number | null;
  earthquakeRisk?: number;
  shelterCapacity?: number;
  agingRisk?: number;
  householdRisk?: number;
  [key: string]: unknown;
}

interface MunicipalityEntry {
  jisCode: string;
  prefecture: string;
  municipality: string;
  overallScore: number;
  overallScoreV2: number;
  diff: number;
  earthquakeRisk: number | null;
  shelterCapacity: number | null;
  agingRisk: number | null;
  householdRisk: number | null;
}

interface Stats {
  min: number;
  max: number;
  mean: number;
  std: number;
}

interface Top30Entry {
  rank: number;
  jisCode: string;
  prefecture: string;
  municipality: string;
  overallScore: number;
  overallScoreV2: number;
  diff: number;
  earthquakeRisk: number | null;
  shelterCapacity: number | null;
  agingRisk: number | null;
  householdRisk: number | null;
}

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

function stats(vals: number[]): Stats {
  if (vals.length === 0) return { min: 0, max: 0, mean: 0, std: 0 };
  const min  = Math.min(...vals);
  const max  = Math.max(...vals);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const std  = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
  return {
    min:  round2(min),
    max:  round2(max),
    mean: round2(mean),
    std:  round2(std),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? 0 : round2(num / denom);
}

function toTop30(entries: MunicipalityEntry[], sortKey: (e: MunicipalityEntry) => number, desc = true): Top30Entry[] {
  return [...entries]
    .sort((a, b) => desc ? sortKey(b) - sortKey(a) : sortKey(a) - sortKey(b))
    .slice(0, 30)
    .map((e, i) => ({ rank: i + 1, ...e }));
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(): { inputPath: string; outputPath: string } {
  const args = process.argv.slice(2);
  const ROOT = path.resolve(__dirname, "../../");
  let inputPath  = path.join(ROOT, "src/data/municipalities.json");
  let outputPath = path.join(ROOT, "data/analysis/overall-v2-diff-summary.json");

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--input"  && args[i + 1]) { inputPath  = path.resolve(args[++i]); }
    if (args[i] === "--output" && args[i + 1]) { outputPath = path.resolve(args[++i]); }
  }
  return { inputPath, outputPath };
}

// ---------------------------------------------------------------------------
// Main analysis
// ---------------------------------------------------------------------------

function analyze(inputPath: string, outputPath: string): void {
  if (!fs.existsSync(inputPath)) {
    console.error(`入力ファイルが見つかりません: ${inputPath}`);
    process.exit(1);
  }

  const raw: MunicipalityRow[] = JSON.parse(fs.readFileSync(inputPath, "utf-8"));
  console.log(`読み込み: ${inputPath} (${raw.length}件)`);

  // overallScoreV2 が設定済みのエントリのみ対象
  const withV2 = raw.filter(
    (m): m is MunicipalityRow & { overallScoreV2: number } =>
      typeof m.overallScoreV2 === "number",
  );
  const withoutV2Count = raw.length - withV2.length;
  if (withoutV2Count > 0) {
    console.warn(`⚠️  overallScoreV2 未設定: ${withoutV2Count}件（分析対象外）`);
  }

  const entries: MunicipalityEntry[] = withV2.map((m) => ({
    jisCode:        m.jisCode ?? m.id,
    prefecture:     m.prefecture,
    municipality:   m.municipality,
    overallScore:   m.overallScore,
    overallScoreV2: m.overallScoreV2,
    diff:           m.overallScoreV2 - m.overallScore,
    earthquakeRisk: typeof m.earthquakeRisk === "number" ? m.earthquakeRisk : null,
    shelterCapacity:typeof m.shelterCapacity === "number" ? m.shelterCapacity : null,
    agingRisk:      typeof m.agingRisk       === "number" ? m.agingRisk       : null,
    householdRisk:  typeof m.householdRisk   === "number" ? m.householdRisk   : null,
  }));

  const diffs        = entries.map((e) => e.diff);
  const absDiffs     = entries.map((e) => Math.abs(e.diff));
  const v1Scores     = entries.map((e) => e.overallScore);
  const v2Scores     = entries.map((e) => e.overallScoreV2);

  // ---------------------------------------------------------------------------
  // 基本統計
  // ---------------------------------------------------------------------------

  const diffStats = stats(diffs);
  const diffResult = {
    ...diffStats,
    absDiffMax:   round2(Math.max(...absDiffs)),
    absDiffMean:  round2(absDiffs.reduce((a, b) => a + b, 0) / absDiffs.length),
    positive:     entries.filter((e) => e.diff > 0).length,
    negative:     entries.filter((e) => e.diff < 0).length,
    unchanged:    entries.filter((e) => e.diff === 0).length,
  };

  // ---------------------------------------------------------------------------
  // Top30
  // ---------------------------------------------------------------------------

  const top30_absDiff   = toTop30(entries, (e) => Math.abs(e.diff));
  const top30_increased = toTop30(entries, (e) => e.diff,  true);
  const top30_decreased = toTop30(entries, (e) => e.diff, false);

  // ---------------------------------------------------------------------------
  // 都道府県別集計
  // ---------------------------------------------------------------------------

  const prefMap = new Map<string, MunicipalityEntry[]>();
  for (const e of entries) {
    const list = prefMap.get(e.prefecture) ?? [];
    list.push(e);
    prefMap.set(e.prefecture, list);
  }

  const byPrefecture = [...prefMap.entries()]
    .map(([prefecture, list]) => {
      const listDiffs = list.map((e) => e.diff);
      const listAbsDiffs = list.map((e) => Math.abs(e.diff));
      return {
        prefecture,
        count:            list.length,
        avgOverallScore:  round2(list.reduce((a, b) => a + b.overallScore,   0) / list.length),
        avgOverallScoreV2:round2(list.reduce((a, b) => a + b.overallScoreV2, 0) / list.length),
        avgDiff:          round2(listDiffs.reduce((a, b) => a + b, 0) / listDiffs.length),
        maxAbsDiff:       Math.max(...listAbsDiffs),
      };
    })
    .sort((a, b) => Math.abs(b.avgDiff) - Math.abs(a.avgDiff)); // |avgDiff| 降順

  // ---------------------------------------------------------------------------
  // 相関分析
  // ---------------------------------------------------------------------------

  // diff との相関を計算するための paired arrays
  const pairedEq       = entries.filter((e) => e.earthquakeRisk  !== null);
  const pairedShelter  = entries.filter((e) => e.shelterCapacity !== null);
  const pairedAging    = entries.filter((e) => e.agingRisk       !== null);
  const pairedHousehold= entries.filter((e) => e.householdRisk   !== null);
  const pairedSocial   = entries.filter((e) => e.agingRisk !== null && e.householdRisk !== null);

  const correlations = {
    earthquakeRisk_vs_diff:   pearson(pairedEq.map((e) => e.earthquakeRisk!),       pairedEq.map((e) => e.diff)),
    shelterCapacity_vs_diff:  pearson(pairedShelter.map((e) => e.shelterCapacity!),  pairedShelter.map((e) => e.diff)),
    agingRisk_vs_diff:        pearson(pairedAging.map((e) => e.agingRisk!),           pairedAging.map((e) => e.diff)),
    householdRisk_vs_diff:    pearson(pairedHousehold.map((e) => e.householdRisk!),  pairedHousehold.map((e) => e.diff)),
    socialScore_vs_diff:      pearson(
      pairedSocial.map((e) => (e.agingRisk! + e.householdRisk!) / 2),
      pairedSocial.map((e) => e.diff),
    ),
  };

  // ---------------------------------------------------------------------------
  // 因子分析（V2カテゴリ別スコアの V1 overallScore との乖離）
  // ---------------------------------------------------------------------------

  const v1Mean = v1Scores.reduce((a, b) => a + b, 0) / v1Scores.length;

  // Hazard カテゴリ: earthquakeRisk
  const eqVals   = entries.filter((e) => e.earthquakeRisk  !== null).map((e) => e.earthquakeRisk!);
  // Infra カテゴリ: shelterCapacity
  const shVals   = entries.filter((e) => e.shelterCapacity !== null).map((e) => e.shelterCapacity!);
  // Social カテゴリ: mean(agingRisk, householdRisk)
  const socVals  = entries
    .filter((e) => e.agingRisk !== null && e.householdRisk !== null)
    .map((e) => (e.agingRisk! + e.householdRisk!) / 2);

  const factorAnalysis = {
    description: "V2カテゴリ別スコアのV1 overallScoreとの乖離分析（高い相関 = そのカテゴリがdiffを主導）",
    v1Mean: round2(v1Mean),
    categories: {
      hazard: {
        source:              "earthquakeRisk",
        weight_in_v2:        0.40,
        n:                   eqVals.length,
        ...stats(eqVals),
        deviationFromV1Mean: round2((eqVals.reduce((a, b) => a + b, 0) / eqVals.length) - v1Mean),
        correlation_with_diff: correlations.earthquakeRisk_vs_diff,
      },
      infrastructure: {
        source:              "shelterCapacity (fallback; 将来 shelterScore に置換予定)",
        weight_in_v2:        0.30,
        n:                   shVals.length,
        ...stats(shVals),
        deviationFromV1Mean: round2((shVals.reduce((a, b) => a + b, 0) / shVals.length) - v1Mean),
        correlation_with_diff: correlations.shelterCapacity_vs_diff,
      },
      social: {
        source:              "mean(agingRisk, householdRisk)",
        weight_in_v2:        0.30,
        n:                   socVals.length,
        ...stats(socVals),
        deviationFromV1Mean: round2((socVals.reduce((a, b) => a + b, 0) / socVals.length) - v1Mean),
        correlation_with_diff: correlations.socialScore_vs_diff,
      },
    },
    interpretation: {
      note: "correlation_with_diff が高い（絶対値）カテゴリほど diff の分散に寄与",
      highCorrelation:  Object.entries(correlations)
        .filter(([, r]) => Math.abs(r) >= 0.3)
        .map(([k, r]) => ({ factor: k, r }))
        .sort((a, b) => Math.abs(b.r) - Math.abs(a.r)),
    },
  };

  // ---------------------------------------------------------------------------
  // V2 分布ヒストグラム（10点刻み）
  // ---------------------------------------------------------------------------

  const v2Histogram: Record<string, number> = {};
  for (const s of v2Scores) {
    const bucket = `${Math.floor(s / 10) * 10}-${Math.floor(s / 10) * 10 + 9}`;
    v2Histogram[bucket] = (v2Histogram[bucket] ?? 0) + 1;
  }

  const diffHistogram: Record<string, number> = {};
  for (const d of diffs) {
    const bucket = d >= 0
      ? `+${Math.floor(d / 5) * 5}〜+${Math.floor(d / 5) * 5 + 4}`
      : `${Math.ceil(d / 5) * 5 - 4}〜${Math.ceil(d / 5) * 5}`;
    diffHistogram[bucket] = (diffHistogram[bucket] ?? 0) + 1;
  }

  // ---------------------------------------------------------------------------
  // 出力
  // ---------------------------------------------------------------------------

  const report = {
    generatedAt:     new Date().toISOString(),
    inputFile:       inputPath,
    calculationNote: "overallScoreV2 = Hazard(40%):earthquakeRisk + Infra(30%):shelterCapacity + Social(30%):mean(agingRisk,householdRisk)",
    summary: {
      total:       raw.length,
      withV2:      withV2.length,
      withoutV2:   withoutV2Count,
    },
    overallScore:   stats(v1Scores),
    overallScoreV2: stats(v2Scores),
    diff:           diffResult,
    distributions: {
      overallScoreV2_histogram: v2Histogram,
      diff_histogram:           diffHistogram,
    },
    top30_absDiff,
    top30_increased,
    top30_decreased,
    byPrefecture,
    correlations,
    factorAnalysis,
  };

  // コンソールサマリー
  console.log("\n=== overallScoreV2 差分分析 ===\n");
  console.log(`総件数: ${report.summary.total} / V2算出済み: ${report.summary.withV2}`);
  console.log(`\noverallScore   : min=${report.overallScore.min}  max=${report.overallScore.max}  mean=${report.overallScore.mean}`);
  console.log(`overallScoreV2 : min=${report.overallScoreV2.min}  max=${report.overallScoreV2.max}  mean=${report.overallScoreV2.mean}`);
  console.log(`\ndiff           : min=${report.diff.min}  max=${report.diff.max}  mean=${report.diff.mean}  std=${report.diff.std}`);
  console.log(`absDiff        : max=${report.diff.absDiffMax}  mean=${report.diff.absDiffMean}`);
  console.log(`V2増加: ${report.diff.positive}件 / V2減少: ${report.diff.negative}件 / 不変: ${report.diff.unchanged}件`);
  console.log(`\n相関（earthquakeRisk vs diff）: ${correlations.earthquakeRisk_vs_diff}`);
  console.log(`相関（shelterCapacity vs diff）: ${correlations.shelterCapacity_vs_diff}`);
  console.log(`相関（agingRisk vs diff）      : ${correlations.agingRisk_vs_diff}`);
  console.log(`相関（householdRisk vs diff）  : ${correlations.householdRisk_vs_diff}`);
  console.log(`相関（socialScore vs diff）    : ${correlations.socialScore_vs_diff}`);
  console.log(`\n最大 |diff| Top3:`);
  top30_absDiff.slice(0, 3).forEach((e) =>
    console.log(`  [${e.jisCode}] ${e.prefecture} ${e.municipality}: ${e.overallScore} → ${e.overallScoreV2} (diff=${e.diff > 0 ? "+" : ""}${e.diff})`),
  );
  console.log(`\nV2で最も上がった Top3:`);
  top30_increased.slice(0, 3).forEach((e) =>
    console.log(`  [${e.jisCode}] ${e.prefecture} ${e.municipality}: +${e.diff} (eq=${e.earthquakeRisk})`),
  );
  console.log(`\nV2で最も下がった Top3:`);
  top30_decreased.slice(0, 3).forEach((e) =>
    console.log(`  [${e.jisCode}] ${e.prefecture} ${e.municipality}: ${e.diff} (eq=${e.earthquakeRisk} shelter=${e.shelterCapacity})`),
  );
  console.log(`\n都道府県別 |avgDiff| Top5:`);
  byPrefecture.slice(0, 5).forEach((p) =>
    console.log(`  ${p.prefecture}: avgDiff=${p.avgDiff > 0 ? "+" : ""}${p.avgDiff}  maxAbsDiff=${p.maxAbsDiff}`),
  );

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf-8");
  console.log(`\n✅ 出力: ${outputPath}`);
}

if (require.main === module) {
  const { inputPath, outputPath } = parseArgs();
  analyze(inputPath, outputPath);
}
