/**
 * score-shelter-sufficiency-v1.ts
 *
 * Computes 避難所充足偏差値 (shelter-sufficiency-v1) for all municipalities.
 * Spec: docs/spec-score-v1.md
 *
 * Usage:
 *   tsx scripts/scoring/score-shelter-sufficiency-v1.ts [--dry-run] [--output <path>]
 *
 *   --dry-run   Print statistics only; do not write output (default if no --output).
 *   --output    Write merged municipalities.json to this path.
 *               If omitted, acts as --dry-run.
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Municipality {
  jisCode: string;
  prefecture: string;
  municipality: string;
  population: number | null;
  [key: string]: unknown;
}

interface ShelterEntry {
  jisCode: string;
  shelterCount: number;
}

type ScoreConfidence = "high" | "no-shelter-data" | "no-data";

interface V1Fields {
  shelterCount: number | null;
  shelterCountPer10k: number | null;
  shelterScore: number | null;
  nationalRank: number | null;
  prefectureRank: number | null;
  dataCompleteness: {
    hasPopulation: boolean;
    hasShelterData: boolean;
  };
  scoreConfidence: ScoreConfidence;
  scoreVersion: "shelter-sufficiency-v1";
  calculationNotes?: string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, "../../");
const MUNICIPALITIES_PATH = path.join(ROOT, "src/data/municipalities.json");
const SHELTERS_PATH = path.join(ROOT, "data/processed/shelters.json");

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(): { dryRun: boolean; outputPath: string | null } {
  const args = process.argv.slice(2);
  let dryRun = true;
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
// Winsorization helpers (spec §6)
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  const i = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function winsorize(values: number[], loPct: number, hiPct: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const lo = percentile(sorted, loPct);
  const hi = percentile(sorted, hiPct);
  return values.map((v) => Math.max(lo, Math.min(hi, v)));
}

function mean(arr: number[]): number {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stddev(arr: number[], mu: number): number {
  const variance = arr.reduce((s, v) => s + (v - mu) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

// ---------------------------------------------------------------------------
// Score computation
// ---------------------------------------------------------------------------

function toShelterScore(x: number, mu: number, sigma: number): number {
  if (sigma === 0) return 50;
  const raw = 50 + 10 * ((x - mu) / sigma);
  return Math.max(10, Math.min(90, Math.round(raw)));
}

// ---------------------------------------------------------------------------
// Dense rank (descending by score, tie-break by jisCode ascending)
// ---------------------------------------------------------------------------

function denseRank(
  entries: Array<{ jisCode: string; shelterScore: number }>,
): Map<string, number> {
  const sorted = [...entries].sort((a, b) =>
    b.shelterScore !== a.shelterScore
      ? b.shelterScore - a.shelterScore
      : a.jisCode.localeCompare(b.jisCode),
  );

  const rankMap = new Map<string, number>();
  let currentRank = 0;
  let prevScore: number | null = null;

  for (const entry of sorted) {
    if (entry.shelterScore !== prevScore) {
      currentRank++;
      prevScore = entry.shelterScore;
    }
    rankMap.set(entry.jisCode, currentRank);
  }

  return rankMap;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const { dryRun, outputPath } = parseArgs();

  // Load inputs
  const municipalities: Municipality[] = JSON.parse(
    fs.readFileSync(MUNICIPALITIES_PATH, "utf-8"),
  );
  const shelters: ShelterEntry[] = JSON.parse(
    fs.readFileSync(SHELTERS_PATH, "utf-8"),
  );

  // Build shelter lookup
  const shelterMap = new Map<string, number>(
    shelters.map((s) => [s.jisCode, s.shelterCount]),
  );

  // Step 1: Attach base v1 fields to each municipality
  interface IntermediateEntry {
    muni: Municipality;
    v1: V1Fields;
  }

  const intermediate: IntermediateEntry[] = municipalities.map((muni) => {
    const shelterCount = shelterMap.has(muni.jisCode)
      ? shelterMap.get(muni.jisCode)!
      : null;

    const hasPopulation =
      muni.population !== null &&
      muni.population !== undefined &&
      typeof muni.population === "number" &&
      muni.population > 0;

    const hasShelterData = shelterCount !== null;

    let scoreConfidence: ScoreConfidence;
    if (!hasPopulation) {
      scoreConfidence = "no-data";
    } else if (!hasShelterData) {
      scoreConfidence = "no-shelter-data";
    } else {
      scoreConfidence = "high";
    }

    const shelterCountPer10k =
      scoreConfidence === "high" &&
      hasShelterData &&
      hasPopulation &&
      shelterCount !== null &&
      muni.population !== null
        ? (shelterCount / muni.population) * 10_000
        : null;

    const v1: V1Fields = {
      shelterCount,
      shelterCountPer10k,
      shelterScore: null,       // computed later
      nationalRank: null,       // computed later
      prefectureRank: null,     // computed later
      dataCompleteness: { hasPopulation, hasShelterData },
      scoreConfidence,
      scoreVersion: "shelter-sufficiency-v1",
    };

    return { muni, v1 };
  });

  // Step 2: Collect valid shelterCountPer10k values for normalization
  const validEntries = intermediate.filter(
    (e) =>
      e.v1.scoreConfidence === "high" && e.v1.shelterCountPer10k !== null,
  );

  if (validEntries.length === 0) {
    console.error(
      "エラー: スコア計算対象エントリが0件です。" +
      "shelters.json と municipalities.json の jisCode が一致しているか確認してください。",
    );
    process.exit(1);
  }

  const rawValues = validEntries.map((e) => e.v1.shelterCountPer10k!);

  // Check skewness (for log1p decision per spec §6)
  const rawMean = mean(rawValues);
  const rawSd = stddev(rawValues, rawMean);
  const rawSkewness =
    rawSd === 0
      ? 0
      : rawValues.reduce((s, v) => s + ((v - rawMean) / rawSd) ** 3, 0) /
        rawValues.length;

  let useLog1p = false;
  let calculationNotes: string | undefined;
  let workingValues = rawValues;

  if (rawSkewness > 3) {
    useLog1p = true;
    calculationNotes = "log1p applied before winsorization";
    workingValues = rawValues.map((v) => Math.log1p(v));
  }

  // Winsorization
  const winsorized = winsorize(workingValues, 1, 99);
  const mu = mean(winsorized);
  const sigma = stddev(winsorized, mu);

  // Assign shelterScore to valid entries
  for (let i = 0; i < validEntries.length; i++) {
    const score = toShelterScore(winsorized[i], mu, sigma);
    validEntries[i].v1.shelterScore = score;
    if (calculationNotes) {
      validEntries[i].v1.calculationNotes = calculationNotes;
    }
  }

  // Step 3: National dense rank
  const rankableEntries = intermediate
    .filter((e) => e.v1.shelterScore !== null)
    .map((e) => ({ jisCode: e.muni.jisCode, shelterScore: e.v1.shelterScore! }));

  const nationalRankMap = denseRank(rankableEntries);

  // Step 4: Prefecture dense rank
  const byPref = new Map<string, Array<{ jisCode: string; shelterScore: number }>>();
  for (const e of intermediate) {
    if (e.v1.shelterScore === null) continue;
    const pref = e.muni.prefecture;
    if (!byPref.has(pref)) byPref.set(pref, []);
    byPref.get(pref)!.push({ jisCode: e.muni.jisCode, shelterScore: e.v1.shelterScore });
  }

  const prefRankMaps = new Map<string, Map<string, number>>();
  for (const [pref, entries] of byPref) {
    prefRankMaps.set(pref, denseRank(entries));
  }

  // Step 5: Apply ranks
  for (const e of intermediate) {
    if (e.v1.shelterScore !== null) {
      e.v1.nationalRank = nationalRankMap.get(e.muni.jisCode) ?? null;
      e.v1.prefectureRank =
        prefRankMaps.get(e.muni.prefecture)?.get(e.muni.jisCode) ?? null;
    }
  }

  // ---------------------------------------------------------------------------
  // Reporting
  // ---------------------------------------------------------------------------

  const total = intermediate.length;
  const high = intermediate.filter((e) => e.v1.scoreConfidence === "high").length;
  const noShelter = intermediate.filter((e) => e.v1.scoreConfidence === "no-shelter-data").length;
  const noData = intermediate.filter((e) => e.v1.scoreConfidence === "no-data").length;

  const scores = intermediate
    .filter((e) => e.v1.shelterScore !== null)
    .map((e) => e.v1.shelterScore!);
  const scoreMin = Math.min(...scores);
  const scoreMax = Math.max(...scores);
  const scoreMean = scores.length > 0 ? mean(scores) : NaN;

  console.log("\n=== 避難所充足偏差値 v1 計算結果 ===");
  console.log(`対象自治体数:       ${total}`);
  console.log(`scoreConfidence=high: ${high} (スコア算出対象)`);
  console.log(`no-shelter-data:     ${noShelter} (GSI未提出)`);
  console.log(`no-data:             ${noData} (population欠損)`);
  console.log("");
  console.log(`正規化ベース件数:   ${rawValues.length}`);
  console.log(`log1p変換:          ${useLog1p ? "適用 (skewness=" + rawSkewness.toFixed(2) + ")" : "未使用 (skewness=" + rawSkewness.toFixed(2) + ")"}`);
  console.log(`shelterCountPer10k μ: ${rawMean.toFixed(4)}`);
  console.log(`shelterCountPer10k σ: ${rawSd.toFixed(4)}`);
  console.log(`Winsorization後 μ:  ${mu.toFixed(4)}`);
  console.log(`Winsorization後 σ:  ${sigma.toFixed(4)}`);
  console.log("");
  console.log(`shelterScore 分布:`);
  console.log(`  min: ${scoreMin}`);
  console.log(`  max: ${scoreMax}`);
  console.log(`  mean: ${scoreMean.toFixed(1)}`);
  console.log(`  クランプ=10 件数: ${scores.filter((s) => s === 10).length}`);
  console.log(`  クランプ=90 件数: ${scores.filter((s) => s === 90).length}`);

  // Show a sample of top/bottom entries
  const ranked = [...intermediate]
    .filter((e) => e.v1.shelterScore !== null)
    .sort((a, b) => (a.v1.nationalRank ?? 9999) - (b.v1.nationalRank ?? 9999) || 0);

  const top5 = ranked.slice(0, 5);
  const bottom5 = ranked.slice(-5).reverse();

  console.log("\n--- 全国上位5 ---");
  for (const e of top5) {
    console.log(
      `  [${e.v1.nationalRank}] ${e.muni.prefecture} ${e.muni.municipality}` +
        ` (${e.muni.jisCode}) score=${e.v1.shelterScore} per10k=${e.v1.shelterCountPer10k?.toFixed(2)}`,
    );
  }

  console.log("\n--- 全国下位5 ---");
  for (const e of bottom5) {
    console.log(
      `  [${e.v1.nationalRank}] ${e.muni.prefecture} ${e.muni.municipality}` +
        ` (${e.muni.jisCode}) score=${e.v1.shelterScore} per10k=${e.v1.shelterCountPer10k?.toFixed(2)}`,
    );
  }

  console.log("");

  if (dryRun) {
    console.log("ℹ️  --dry-run モード: ファイルへの書き込みは行いません。");
    console.log("   実際に書き込むには --output <path> を指定してください。");
    return;
  }

  // ---------------------------------------------------------------------------
  // Write output
  // ---------------------------------------------------------------------------

  const output = intermediate.map(({ muni, v1 }) => {
    const merged: Record<string, unknown> = { ...muni };

    // v1 fields
    merged["shelterCount"] = v1.shelterCount;
    merged["shelterCountPer10k"] = v1.shelterCountPer10k;
    merged["shelterScore"] = v1.shelterScore;
    merged["nationalRank"] = v1.nationalRank;
    merged["prefectureRank"] = v1.prefectureRank;
    merged["dataCompleteness"] = v1.dataCompleteness;
    merged["scoreConfidence"] = v1.scoreConfidence;
    merged["scoreVersion"] = v1.scoreVersion;
    if (v1.calculationNotes) {
      merged["calculationNotes"] = v1.calculationNotes;
    }

    return merged;
  });

  const resolvedOutput = path.resolve(outputPath!);
  fs.writeFileSync(resolvedOutput, JSON.stringify(output, null, 2), "utf-8");
  console.log(`✅ 書き込み完了: ${resolvedOutput} (${output.length}件)`);
}

main();
