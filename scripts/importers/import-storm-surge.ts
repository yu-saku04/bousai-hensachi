/**
 * import-storm-surge.ts — storm-surge-scores.json → data/processed/storm-surge.json
 *
 * storm-surge-scores.json を読み込み、
 * municipalities.json の1918件を基準として storm-surge.json (1918件) を出力する。
 *
 * not-processed 20件（政令指定都市市全体コード）:
 *   → 区コードの stormSurgeRiskCandidate を単純平均して "ward-averaged" として出力。
 *
 * not-found（沿岸県だが NLFTP に A49 なし）:
 *   → "missing" として出力（stormSurgeRiskCandidate=null）。
 *
 * no-storm-surge-risk（内陸県）:
 *   → そのまま出力（score=100）。
 *
 * 所属未定地・municipalities.json に存在しない jisCode:
 *   → 警告ログのみ出力して除外。
 *
 * Usage:
 *   tsx scripts/importers/import-storm-surge.ts [--input PATH] [--output PATH]
 */

import fs from "fs";
import path from "path";

const DEFAULT_INPUT          = "data/processed/storm-surge-scores.json";
const DEFAULT_MUNI_PATH      = "src/data/municipalities.json";
const DEFAULT_OUTPUT         = "data/processed/storm-surge.json";
const CALC_VERSION           = "storm-surge-v1" as const;
const DEFAULT_SOURCE         = "国土交通省 国土数値情報 高潮浸水想定区域データ";

const JIS_RE = /^\d{5}$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StormSurgeScoreEntry {
  jisCode:                 string;
  stormSurgeRiskCandidate: number | null;
  stormSurgeDataStatus:    string;
  stormSurgeAreaRatio:     number | null;
  stormSurgeMaxDepthM:     number | null;
  stormSurgeSource:        string | null;
  stormSurgeUpdatedAt:     string;
  calculationVersion:      string;
}

export type StormSurgeDataStatus =
  | "scored"
  | "no-storm-surge-data"
  | "no-storm-surge-risk"
  | "ward-averaged"
  | "missing";

export interface StormSurgeEntry {
  jisCode:                 string;
  stormSurgeRiskCandidate: number | null;
  stormSurgeDataStatus:    StormSurgeDataStatus;
  stormSurgeAreaRatio:     number | null;
  stormSurgeMaxDepthM:     number | null;
  stormSurgeSource:        string;
  stormSurgeUpdatedAt:     string;
  calculationVersion:      typeof CALC_VERSION;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * 政令市コード C に対応する区コードを storm-surge-scores の全コードから特定する。
 */
function findWardCodes(
  cityCode:         string,
  notProcessedCodes: Set<string>,
  allSurgeCodes:    string[],
): string[] {
  const prefix = cityCode.slice(0, 3);

  const sibling = [...notProcessedCodes]
    .filter((c) => c.slice(0, 3) === prefix && c > cityCode)
    .sort()[0];

  const upperBound = sibling ??
    ((Number(prefix) + 1).toString().padStart(3, "0") + "00");

  return allSurgeCodes.filter(
    (c) =>
      JIS_RE.test(c) &&
      !notProcessedCodes.has(c) &&
      c > cityCode &&
      c < upperBound,
  );
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

export function importStormSurge(
  inputPath: string,
  muniPath:  string,
): StormSurgeEntry[] {
  if (!fs.existsSync(inputPath)) {
    throw new Error(
      `入力ファイルが見つかりません: ${inputPath}\n` +
      `  npm run score:storm-surge-v1:all を先に実行してください。`,
    );
  }
  const rawSurge = JSON.parse(
    fs.readFileSync(inputPath, "utf-8"),
  ) as StormSurgeScoreEntry[];
  console.log(`storm-surge-scores.json: ${rawSurge.length}件`);

  if (!fs.existsSync(muniPath)) {
    throw new Error(`municipalities.json が見つかりません: ${muniPath}`);
  }
  const rawMuni = JSON.parse(
    fs.readFileSync(muniPath, "utf-8"),
  ) as Array<{ jisCode: string }>;
  const muniCodes = new Set(rawMuni.map((m) => m.jisCode));
  console.log(`municipalities.json: ${rawMuni.length}件`);

  // surge map 構築（所属未定地は除外）
  const surgeMap = new Map<string, StormSurgeScoreEntry>();
  const excluded: string[] = [];

  for (const r of rawSurge) {
    if (!muniCodes.has(r.jisCode)) {
      excluded.push(r.jisCode);
      continue;
    }
    surgeMap.set(r.jisCode, r);
  }

  if (excluded.length > 0) {
    console.warn(
      `\n⚠️  municipalities.json に存在しない jisCode を除外 (${excluded.length}件):`,
    );
    for (const c of excluded) console.warn(`  ${c}`);
  }

  // not-processed コード（政令市市全体）を特定
  const notProcessedCodes = new Set(
    rawSurge
      .filter((r) => r.stormSurgeDataStatus === "not-processed")
      .map((r) => r.jisCode),
  );
  const allSurgeCodes = rawSurge.map((r) => r.jisCode);

  // 1918件ループ
  const results: StormSurgeEntry[] = [];
  let scoredCount    = 0;
  let noDataCount    = 0;
  let noRiskCount    = 0;
  let wardAvgCount   = 0;
  let missingCount   = 0;
  let notFoundCount  = 0;
  const warnings: string[] = [];

  const today = new Date().toISOString().slice(0, 10);

  for (const m of rawMuni) {
    const { jisCode } = m;
    const surge = surgeMap.get(jisCode);

    // storm-surge-scores.json に存在しない自治体
    if (!surge) {
      warnings.push(`[${jisCode}] storm-surge-scores.json に存在しません`);
      results.push({
        jisCode,
        stormSurgeRiskCandidate: null,
        stormSurgeDataStatus:    "missing",
        stormSurgeAreaRatio:     null,
        stormSurgeMaxDepthM:     null,
        stormSurgeSource:        DEFAULT_SOURCE,
        stormSurgeUpdatedAt:     today,
        calculationVersion:      CALC_VERSION,
      });
      missingCount++;
      continue;
    }

    // not-found（NLFTP 未収録沿岸県）→ missing
    if (surge.stormSurgeDataStatus === "not-found") {
      results.push({
        jisCode,
        stormSurgeRiskCandidate: null,
        stormSurgeDataStatus:    "missing",
        stormSurgeAreaRatio:     null,
        stormSurgeMaxDepthM:     null,
        stormSurgeSource:        surge.stormSurgeSource || DEFAULT_SOURCE,
        stormSurgeUpdatedAt:     surge.stormSurgeUpdatedAt,
        calculationVersion:      CALC_VERSION,
      });
      missingCount++;
      notFoundCount++;
      continue;
    }

    // scored / no-storm-surge-data / no-storm-surge-risk: そのまま出力
    if (
      surge.stormSurgeDataStatus === "scored" ||
      surge.stormSurgeDataStatus === "no-storm-surge-data" ||
      surge.stormSurgeDataStatus === "no-storm-surge-risk"
    ) {
      results.push({
        jisCode,
        stormSurgeRiskCandidate: surge.stormSurgeRiskCandidate,
        stormSurgeDataStatus:    surge.stormSurgeDataStatus as
          "scored" | "no-storm-surge-data" | "no-storm-surge-risk",
        stormSurgeAreaRatio: surge.stormSurgeAreaRatio,
        stormSurgeMaxDepthM: surge.stormSurgeMaxDepthM,
        stormSurgeSource:    surge.stormSurgeSource || DEFAULT_SOURCE,
        stormSurgeUpdatedAt: surge.stormSurgeUpdatedAt,
        calculationVersion:  CALC_VERSION,
      });
      if (surge.stormSurgeDataStatus === "scored")               scoredCount++;
      else if (surge.stormSurgeDataStatus === "no-storm-surge-data") noDataCount++;
      else                                                             noRiskCount++;
      continue;
    }

    // not-processed → 区コードの stormSurgeRiskCandidate を単純平均
    const wardCodes  = findWardCodes(jisCode, notProcessedCodes, allSurgeCodes);
    const wardScores = wardCodes
      .map((wc) => surgeMap.get(wc)?.stormSurgeRiskCandidate)
      .filter((v): v is number => typeof v === "number");

    if (wardScores.length === 0) {
      warnings.push(
        `[${jisCode}] 区データなし → missing 扱い (wardCandidates=${wardCodes.length})`,
      );
      results.push({
        jisCode,
        stormSurgeRiskCandidate: null,
        stormSurgeDataStatus:    "missing",
        stormSurgeAreaRatio:     null,
        stormSurgeMaxDepthM:     null,
        stormSurgeSource:        surge.stormSurgeSource || DEFAULT_SOURCE,
        stormSurgeUpdatedAt:     surge.stormSurgeUpdatedAt,
        calculationVersion:      CALC_VERSION,
      });
      missingCount++;
      continue;
    }

    const avg       = wardScores.reduce((a, b) => a + b, 0) / wardScores.length;
    // 内陸 政令市（全区 score=100）→ 100 を許容、上限 100
    const candidate = Math.max(10, Math.min(100, Math.round(avg)));

    results.push({
      jisCode,
      stormSurgeRiskCandidate: candidate,
      stormSurgeDataStatus:    "ward-averaged",
      stormSurgeAreaRatio:     null,
      stormSurgeMaxDepthM:     null,
      stormSurgeSource:        surge.stormSurgeSource || DEFAULT_SOURCE,
      stormSurgeUpdatedAt:     surge.stormSurgeUpdatedAt,
      calculationVersion:      CALC_VERSION,
    });
    wardAvgCount++;

    console.log(
      `  [${jisCode}] ward-averaged: ${wardScores.length}区 → ${candidate}` +
      ` (range: ${Math.min(...wardScores)}〜${Math.max(...wardScores)})`,
    );
  }

  // 警告出力
  if (warnings.length > 0) {
    console.warn(`\n⚠️  警告 (${warnings.length}件):`);
    for (const w of warnings) console.warn(`  ${w}`);
  }

  // 統計
  const candidates = results
    .map((r) => r.stormSurgeRiskCandidate)
    .filter((v): v is number => v !== null);
  const cMin  = candidates.length > 0 ? Math.min(...candidates) : 0;
  const cMax  = candidates.length > 0 ? Math.max(...candidates) : 0;
  const cMean = candidates.length > 0
    ? (candidates.reduce((a, b) => a + b, 0) / candidates.length).toFixed(1)
    : "—";

  console.log(`\n--- import-storm-surge 統計 ---`);
  console.log(`total                  : ${results.length}件`);
  console.log(`scored                 : ${scoredCount}件`);
  console.log(`no-storm-surge-data    : ${noDataCount}件`);
  console.log(`no-storm-surge-risk    : ${noRiskCount}件`);
  console.log(`ward-averaged          : ${wardAvgCount}件`);
  console.log(`missing                : ${missingCount}件 (うち not-found 由来: ${notFoundCount}件)`);
  console.log(`\nstormSurgeRiskCandidate: min=${cMin} max=${cMax} mean=${cMean}`);

  return results;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (require.main === module) {
  const inputPath  = getArg("--input")  ?? DEFAULT_INPUT;
  const outputPath = getArg("--output") ?? DEFAULT_OUTPUT;

  try {
    const results = importStormSurge(inputPath, DEFAULT_MUNI_PATH);

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), "utf-8");
    const sizeKb = (fs.statSync(outputPath).size / 1024).toFixed(1);
    console.log(`\n✅ 書き出し完了: ${outputPath} (${results.length}件, ${sizeKb} KB)`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
