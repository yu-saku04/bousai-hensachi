/**
 * import-flood.ts — flood-scores.json → data/processed/flood.json
 *
 * flood-scores.json (1925件 = 1918自治体 + 7件所属未定地) を読み込み、
 * municipalities.json の1918件を基準として flood.json (1918件) を出力する。
 *
 * not-processed 20件（政令指定都市市全体コード）:
 *   → 区コードの floodRiskCandidate を単純平均して "ward-averaged" として出力。
 *   → 区コードの同定: 同一3桁プレフィックス内の次の政令市コードまでの範囲を使用。
 *
 * 所属未定地 7件（municipalities.json に存在しない jisCode）:
 *   → 警告ログのみ出力して除外。
 *
 * Usage:
 *   tsx scripts/importers/import-flood.ts [--input PATH] [--output PATH]
 */

import fs from "fs";
import path from "path";

const DEFAULT_INPUT     = "data/processed/flood-scores.json";
const DEFAULT_MUNI_PATH = "src/data/municipalities.json";
const DEFAULT_OUTPUT    = "data/processed/flood.json";
const CALC_VERSION      = "flood-v1" as const;

const JIS_RE = /^\d{5}$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FloodScoreEntry {
  jisCode:            string;
  floodRiskCandidate: number;
  maxDepthCode:       number;
  maxDepthDanger:     number;
  floodAreaRatio:     number;
  floodDataStatus:    string;
  floodSource:        string;
  floodUpdatedAt:     string;
  calculationVersion: string;
}

export type FloodDataStatus = "scored" | "no-flood-data" | "ward-averaged" | "missing";

export interface FloodEntry {
  jisCode:            string;
  floodRiskCandidate: number | null;
  floodDataStatus:    FloodDataStatus;
  maxDepthCode:       number | null;
  maxDepthDanger:     number | null;
  floodAreaRatio:     number | null;
  floodSource:        string;
  floodUpdatedAt:     string;
  calculationVersion: typeof CALC_VERSION;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * 政令市コード C に対応する区コードを flood-scores の全コードから特定する。
 *
 * 区コードの同定ルール:
 *   - 同一3桁プレフィックス（C[:3]）を持つ
 *   - C より大きく、同一プレフィックス内の次の政令市コード未満
 *   - not-processed コード（政令市市全体）は除外
 */
function findWardCodes(
  cityCode:          string,
  notProcessedCodes: Set<string>,
  allFloodCodes:     string[],
): string[] {
  const prefix = cityCode.slice(0, 3);

  // 同一プレフィックスの政令市コードのうち cityCode より大きい最小値 = 上限
  const sibling = [...notProcessedCodes]
    .filter((c) => c.slice(0, 3) === prefix && c > cityCode)
    .sort()[0];

  // 上限がない場合はプレフィックスを +1 した仮想コード（"14200" 等）
  const upperBound = sibling ??
    ((Number(prefix) + 1).toString().padStart(3, "0") + "00");

  return allFloodCodes.filter(
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

export function importFlood(
  inputPath:  string,
  muniPath:   string,
): FloodEntry[] {
  // flood-scores.json を読み込み
  if (!fs.existsSync(inputPath)) {
    throw new Error(
      `入力ファイルが見つかりません: ${inputPath}\n` +
      `  npm run score:flood-v1:all を先に実行してください。`,
    );
  }
  const rawFlood = JSON.parse(
    fs.readFileSync(inputPath, "utf-8"),
  ) as FloodScoreEntry[];
  console.log(`flood-scores.json: ${rawFlood.length}件`);

  // municipalities.json を権威リストとして読み込み
  if (!fs.existsSync(muniPath)) {
    throw new Error(`municipalities.json が見つかりません: ${muniPath}`);
  }
  const rawMuni = JSON.parse(
    fs.readFileSync(muniPath, "utf-8"),
  ) as Array<{ jisCode: string }>;
  const muniCodes = new Set(rawMuni.map((m) => m.jisCode));
  console.log(`municipalities.json: ${rawMuni.length}件`);

  // flood map 構築（所属未定地は除外）
  const floodMap = new Map<string, FloodScoreEntry>();
  const excluded: string[] = [];

  for (const r of rawFlood) {
    if (!muniCodes.has(r.jisCode)) {
      excluded.push(r.jisCode);
      continue;
    }
    floodMap.set(r.jisCode, r);
  }

  if (excluded.length > 0) {
    console.warn(
      `\n⚠️  municipalities.json に存在しない jisCode を除外 (${excluded.length}件):`,
    );
    for (const c of excluded) console.warn(`  ${c}`);
  }

  // not-processed コード（政令市市全体）を特定
  const notProcessedCodes = new Set(
    rawFlood
      .filter((r) => r.floodDataStatus === "not-processed")
      .map((r) => r.jisCode),
  );
  const allFloodCodes = rawFlood.map((r) => r.jisCode);

  // 1918件ループ
  const results:  FloodEntry[] = [];
  let scoredCount   = 0;
  let noFloodCount  = 0;
  let wardAvgCount  = 0;
  let missingCount  = 0;
  const warnings:  string[] = [];

  for (const m of rawMuni) {
    const { jisCode } = m;
    const flood = floodMap.get(jisCode);

    // flood-scores.json に存在しない自治体（欠損）
    if (!flood) {
      warnings.push(`[${jisCode}] flood-scores.json に存在しません`);
      results.push({
        jisCode,
        floodRiskCandidate: null,
        floodDataStatus:    "missing",
        maxDepthCode:       null,
        maxDepthDanger:     null,
        floodAreaRatio:     null,
        floodSource:        "",
        floodUpdatedAt:     "",
        calculationVersion: CALC_VERSION,
      });
      missingCount++;
      continue;
    }

    // scored / no-flood-data: そのまま出力
    if (flood.floodDataStatus === "scored" || flood.floodDataStatus === "no-flood-data") {
      results.push({
        jisCode,
        floodRiskCandidate: flood.floodRiskCandidate,
        floodDataStatus:    flood.floodDataStatus as "scored" | "no-flood-data",
        maxDepthCode:       flood.maxDepthCode,
        maxDepthDanger:     flood.maxDepthDanger,
        floodAreaRatio:     flood.floodAreaRatio,
        floodSource:        flood.floodSource,
        floodUpdatedAt:     flood.floodUpdatedAt,
        calculationVersion: CALC_VERSION,
      });
      if (flood.floodDataStatus === "scored") scoredCount++;
      else noFloodCount++;
      continue;
    }

    // not-processed → 区コードの floodRiskCandidate を単純平均
    const wardCodes  = findWardCodes(jisCode, notProcessedCodes, allFloodCodes);
    const wardScores = wardCodes
      .map((wc) => floodMap.get(wc)?.floodRiskCandidate)
      .filter((v): v is number => typeof v === "number");

    if (wardScores.length === 0) {
      warnings.push(
        `[${jisCode}] 区データなし → missing 扱い (wardCandidates=${wardCodes.length})`,
      );
      results.push({
        jisCode,
        floodRiskCandidate: null,
        floodDataStatus:    "missing",
        maxDepthCode:       null,
        maxDepthDanger:     null,
        floodAreaRatio:     null,
        floodSource:        flood.floodSource,
        floodUpdatedAt:     flood.floodUpdatedAt,
        calculationVersion: CALC_VERSION,
      });
      missingCount++;
      continue;
    }

    const avg       = wardScores.reduce((a, b) => a + b, 0) / wardScores.length;
    const candidate = Math.max(10, Math.min(90, Math.round(avg)));

    results.push({
      jisCode,
      floodRiskCandidate: candidate,
      floodDataStatus:    "ward-averaged",
      maxDepthCode:       null,
      maxDepthDanger:     null,
      floodAreaRatio:     null,
      floodSource:        flood.floodSource,
      floodUpdatedAt:     flood.floodUpdatedAt,
      calculationVersion: CALC_VERSION,
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
    .map((r) => r.floodRiskCandidate)
    .filter((v): v is number => v !== null);
  const cMin  = candidates.length > 0 ? Math.min(...candidates) : 0;
  const cMax  = candidates.length > 0 ? Math.max(...candidates) : 0;
  const cMean = candidates.length > 0
    ? (candidates.reduce((a, b) => a + b, 0) / candidates.length).toFixed(1)
    : "—";

  console.log(`\n--- import-flood 統計 ---`);
  console.log(`total          : ${results.length}件`);
  console.log(`scored         : ${scoredCount}件`);
  console.log(`no-flood-data  : ${noFloodCount}件`);
  console.log(`ward-averaged  : ${wardAvgCount}件`);
  console.log(`missing        : ${missingCount}件`);
  console.log(`\nfloodRiskCandidate: min=${cMin} max=${cMax} mean=${cMean}`);

  return results;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (require.main === module) {
  const inputPath  = getArg("--input")  ?? DEFAULT_INPUT;
  const outputPath = getArg("--output") ?? DEFAULT_OUTPUT;

  try {
    const results = importFlood(inputPath, DEFAULT_MUNI_PATH);

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), "utf-8");
    const sizeKb = (fs.statSync(outputPath).size / 1024).toFixed(1);
    console.log(`\n✅ 書き出し完了: ${outputPath} (${results.length}件, ${sizeKb} KB)`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
