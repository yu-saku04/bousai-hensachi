/**
 * import-landslide.ts — landslide-scores.json → data/processed/landslide.json
 *
 * landslide-scores.json (全国 1918+α件) を読み込み、
 * municipalities.json の1918件を基準として landslide.json (1918件) を出力する。
 *
 * not-processed 20件（政令指定都市市全体コード）:
 *   → 区コードの landslideRiskCandidate を単純平均して "ward-averaged" として出力。
 *   → 区コードの同定: 同一3桁プレフィックス内の次の政令市コードまでの範囲を使用。
 *
 * 所属未定地・pref=23(愛知)欠損（municipalities.json に存在しない jisCode）:
 *   → 警告ログのみ出力して除外。
 *
 * Usage:
 *   tsx scripts/importers/import-landslide.ts [--input PATH] [--output PATH]
 */

import fs from "fs";
import path from "path";

const DEFAULT_INPUT          = "data/processed/landslide-scores.json";
const DEFAULT_MUNI_PATH      = "src/data/municipalities.json";
const DEFAULT_OUTPUT         = "data/processed/landslide.json";
const CALC_VERSION           = "landslide-v1" as const;
const DEFAULT_LANDSLIDE_SOURCE = "国土交通省 国土数値情報 土砂災害警戒区域等 A33-15";

const JIS_RE = /^\d{5}$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LandslideScoreEntry {
  jisCode:                   string;
  landslideRiskCandidate:    number;
  landslideDataStatus:       string;
  landslideAreaRatio:        number;
  landslideSpecialAreaRatio: number;
  landslideSource:           string;
  landslideUpdatedAt:        string;
  calculationVersion:        string;
}

export type LandslideDataStatus = "scored" | "no-landslide-data" | "ward-averaged" | "missing";

export interface LandslideEntry {
  jisCode:                   string;
  landslideRiskCandidate:    number | null;
  landslideDataStatus:       LandslideDataStatus;
  landslideAreaRatio:        number | null;
  landslideSpecialAreaRatio: number | null;
  landslideSource:           string;
  landslideUpdatedAt:        string;
  calculationVersion:        typeof CALC_VERSION;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * 政令市コード C に対応する区コードを landslide-scores の全コードから特定する。
 *
 * 区コードの同定ルール:
 *   - 同一3桁プレフィックス（C[:3]）を持つ
 *   - C より大きく、同一プレフィックス内の次の政令市コード未満
 *   - not-processed コード（政令市市全体）は除外
 */
function findWardCodes(
  cityCode:          string,
  notProcessedCodes: Set<string>,
  allLandCodes:      string[],
): string[] {
  const prefix = cityCode.slice(0, 3);

  const sibling = [...notProcessedCodes]
    .filter((c) => c.slice(0, 3) === prefix && c > cityCode)
    .sort()[0];

  const upperBound = sibling ??
    ((Number(prefix) + 1).toString().padStart(3, "0") + "00");

  return allLandCodes.filter(
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

export function importLandslide(
  inputPath: string,
  muniPath:  string,
): LandslideEntry[] {
  if (!fs.existsSync(inputPath)) {
    throw new Error(
      `入力ファイルが見つかりません: ${inputPath}\n` +
      `  npm run score:landslide-v1:all を先に実行してください。`,
    );
  }
  const rawLand = JSON.parse(
    fs.readFileSync(inputPath, "utf-8"),
  ) as LandslideScoreEntry[];
  console.log(`landslide-scores.json: ${rawLand.length}件`);

  if (!fs.existsSync(muniPath)) {
    throw new Error(`municipalities.json が見つかりません: ${muniPath}`);
  }
  const rawMuni = JSON.parse(
    fs.readFileSync(muniPath, "utf-8"),
  ) as Array<{ jisCode: string }>;
  const muniCodes = new Set(rawMuni.map((m) => m.jisCode));
  console.log(`municipalities.json: ${rawMuni.length}件`);

  // landslide map 構築（所属未定地は除外）
  const landMap = new Map<string, LandslideScoreEntry>();
  const excluded: string[] = [];

  for (const r of rawLand) {
    if (!muniCodes.has(r.jisCode)) {
      excluded.push(r.jisCode);
      continue;
    }
    landMap.set(r.jisCode, r);
  }

  if (excluded.length > 0) {
    console.warn(
      `\n⚠️  municipalities.json に存在しない jisCode を除外 (${excluded.length}件):`,
    );
    for (const c of excluded) console.warn(`  ${c}`);
  }

  // not-processed コード（政令市市全体）を特定
  const notProcessedCodes = new Set(
    rawLand
      .filter((r) => r.landslideDataStatus === "not-processed")
      .map((r) => r.jisCode),
  );
  const allLandCodes = rawLand.map((r) => r.jisCode);

  // 1918件ループ
  const results: LandslideEntry[] = [];
  let scoredCount      = 0;
  let noLandCount      = 0;
  let wardAvgCount     = 0;
  let missingCount     = 0;
  let notFoundCount    = 0;
  const warnings: string[] = [];

  for (const m of rawMuni) {
    const { jisCode } = m;
    const land = landMap.get(jisCode);

    // landslide-scores.json に存在しない自治体（欠損）
    if (!land) {
      warnings.push(`[${jisCode}] landslide-scores.json に存在しません`);
      results.push({
        jisCode,
        landslideRiskCandidate:    null,
        landslideDataStatus:       "missing",
        landslideAreaRatio:        null,
        landslideSpecialAreaRatio: null,
        landslideSource:           DEFAULT_LANDSLIDE_SOURCE,
        landslideUpdatedAt:        new Date().toISOString().slice(0, 10),
        calculationVersion:        CALC_VERSION,
      });
      missingCount++;
      continue;
    }

    // not-found (A33 データなし / 既知欠損都道府県) → missing として出力
    if (land.landslideDataStatus === "not-found") {
      results.push({
        jisCode,
        landslideRiskCandidate:    null,
        landslideDataStatus:       "missing",
        landslideAreaRatio:        null,
        landslideSpecialAreaRatio: null,
        landslideSource:           land.landslideSource || DEFAULT_LANDSLIDE_SOURCE,
        landslideUpdatedAt:        land.landslideUpdatedAt,
        calculationVersion:        CALC_VERSION,
      });
      missingCount++;
      notFoundCount++;
      continue;
    }

    // scored / no-landslide-data: そのまま出力
    if (
      land.landslideDataStatus === "scored" ||
      land.landslideDataStatus === "no-landslide-data"
    ) {
      results.push({
        jisCode,
        landslideRiskCandidate:    land.landslideRiskCandidate,
        landslideDataStatus:       land.landslideDataStatus as "scored" | "no-landslide-data",
        landslideAreaRatio:        land.landslideAreaRatio,
        landslideSpecialAreaRatio: land.landslideSpecialAreaRatio,
        landslideSource:           land.landslideSource || DEFAULT_LANDSLIDE_SOURCE,
        landslideUpdatedAt:        land.landslideUpdatedAt,
        calculationVersion:        CALC_VERSION,
      });
      if (land.landslideDataStatus === "scored") scoredCount++;
      else noLandCount++;
      continue;
    }

    // not-processed → 区コードの landslideRiskCandidate を単純平均
    const wardCodes  = findWardCodes(jisCode, notProcessedCodes, allLandCodes);
    const wardScores = wardCodes
      .map((wc) => landMap.get(wc)?.landslideRiskCandidate)
      .filter((v): v is number => typeof v === "number");

    if (wardScores.length === 0) {
      warnings.push(
        `[${jisCode}] 区データなし → missing 扱い (wardCandidates=${wardCodes.length})`,
      );
      results.push({
        jisCode,
        landslideRiskCandidate:    null,
        landslideDataStatus:       "missing",
        landslideAreaRatio:        null,
        landslideSpecialAreaRatio: null,
        landslideSource:           land.landslideSource || DEFAULT_LANDSLIDE_SOURCE,
        landslideUpdatedAt:        land.landslideUpdatedAt,
        calculationVersion:        CALC_VERSION,
      });
      missingCount++;
      continue;
    }

    const avg       = wardScores.reduce((a, b) => a + b, 0) / wardScores.length;
    const candidate = Math.max(10, Math.min(90, Math.round(avg)));

    results.push({
      jisCode,
      landslideRiskCandidate:    candidate,
      landslideDataStatus:       "ward-averaged",
      landslideAreaRatio:        null,
      landslideSpecialAreaRatio: null,
      landslideSource:           land.landslideSource || DEFAULT_LANDSLIDE_SOURCE,
      landslideUpdatedAt:        land.landslideUpdatedAt,
      calculationVersion:        CALC_VERSION,
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
    .map((r) => r.landslideRiskCandidate)
    .filter((v): v is number => v !== null);
  const cMin  = candidates.length > 0 ? Math.min(...candidates) : 0;
  const cMax  = candidates.length > 0 ? Math.max(...candidates) : 0;
  const cMean = candidates.length > 0
    ? (candidates.reduce((a, b) => a + b, 0) / candidates.length).toFixed(1)
    : "—";

  console.log(`\n--- import-landslide 統計 ---`);
  console.log(`total               : ${results.length}件`);
  console.log(`scored              : ${scoredCount}件`);
  console.log(`no-landslide-data   : ${noLandCount}件`);
  console.log(`ward-averaged       : ${wardAvgCount}件`);
  console.log(`missing             : ${missingCount}件 (うち not-found 由来: ${notFoundCount}件)`);
  console.log(`\nlandslideRiskCandidate: min=${cMin} max=${cMax} mean=${cMean}`);

  return results;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (require.main === module) {
  const inputPath  = getArg("--input")  ?? DEFAULT_INPUT;
  const outputPath = getArg("--output") ?? DEFAULT_OUTPUT;

  try {
    const results = importLandslide(inputPath, DEFAULT_MUNI_PATH);

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), "utf-8");
    const sizeKb = (fs.statSync(outputPath).size / 1024).toFixed(1);
    console.log(`\n✅ 書き出し完了: ${outputPath} (${results.length}件, ${sizeKb} KB)`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
