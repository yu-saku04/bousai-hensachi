/**
 * import-liquefaction.ts — liquefaction-scores.json → data/processed/liquefaction.json
 *
 * liquefaction-scores.json を読み込み、municipalities.json の1918件を基準として
 * liquefaction.json (1918件) を出力する。
 *
 * not-processed（政令市市全体コード）:
 *   → 区コードの score を validLandMeshCount 加重平均で "ward-averaged" として出力。
 *   → terrainComposition も validLandMeshCount で加重平均。
 *   → liquefactionMaxRiskClass は区の最大リスク地形を採用。
 *
 * not-found → missing
 * jisCode が municipalities.json に存在しない（12000 等）→ 除外。
 *
 * Usage:
 *   tsx scripts/importers/import-liquefaction.ts [--input PATH] [--output PATH]
 */

import fs from "fs";
import path from "path";

const DEFAULT_INPUT     = "data/processed/liquefaction-scores.json";
const DEFAULT_MUNI_PATH = "src/data/municipalities.json";
const DEFAULT_OUTPUT    = "data/processed/liquefaction.json";
const CALC_VERSION      = "liquefaction-v1" as const;
const DEFAULT_SOURCE    = "防災科学技術研究所（NIED）J-SHIS 250mメッシュ微地形区分データ（若松・松岡、2020）";
const DEFAULT_METHOD    = "jshis-mesh-terrain";

const JIS_RE = /^\d{5}$/;

// Risk weights matching score-liquefaction-v1.py
const TERRAIN_RISK: Record<string, number> = {
  "山地": 0, "山麓地": 0, "火山地": 0, "火山山麓地": 0, "丘陵": 0,
  "台地（礫質）": 0, "台地（ローム）": 0, "台地（未分類）": 0,
  "礫地": 0, "岩礁": 0,
  "扇状地": 25, "砂礫質低地": 30,
  "自然堤防": 55,
  "低地（一般）": 45, "高水敷": 35,
  "砂丘": 40, "河原": 40,
  "砂州・浜堤": 65,
  "後背湿地": 75,
  "三角州・海岸低地": 80, "旧河道": 90,
  "干拓地": 95, "埋立地": 100,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RawEntry {
  jisCode:                          string;
  prefectureCode?:                  string;
  prefectureName?:                  string;
  municipalityName?:                string;
  liquefactionRiskCandidate:        number | null;
  liquefactionDataStatus:           string;
  liquefactionSusceptibleAreaRatio: number | null;
  liquefactionHighRiskAreaRatio:    number | null;
  liquefactionMaxRiskClass:         string | null;
  liquefactionUpdatedAt:            string;
  liquefactionSource?:              string;
  liquefactionMethod?:              string;
  terrainComposition:               Record<string, number>;
  validLandMeshCount:               number;
  totalAssignedMeshCount:           number;
  calculationVersion?:              string;
}

export type LiquefactionDataStatus =
  | "scored"
  | "no-liquefaction-risk"
  | "no-liquefaction-area"
  | "ward-averaged"
  | "missing";

export interface LiquefactionEntry {
  jisCode:                          string;
  liquefactionRiskCandidate:        number | null;
  liquefactionDataStatus:           LiquefactionDataStatus;
  liquefactionSusceptibleAreaRatio: number | null;
  liquefactionHighRiskAreaRatio:    number | null;
  liquefactionMaxRiskClass:         string | null;
  liquefactionUpdatedAt:            string;
  liquefactionSource:               string;
  liquefactionMethod:               string;
  terrainComposition:               Record<string, number>;
  validLandMeshCount:               number | null;
  calculationVersion:               typeof CALC_VERSION;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function findWardCodes(
  cityCode:          string,
  notProcessedCodes: Set<string>,
  allCodes:          string[],
): string[] {
  const prefix = cityCode.slice(0, 3);
  const sibling = [...notProcessedCodes]
    .filter((c) => c.slice(0, 3) === prefix && c > cityCode)
    .sort()[0];
  const upperBound = sibling ??
    ((Number(prefix) + 1).toString().padStart(3, "0") + "00");
  return allCodes.filter(
    (c) => JIS_RE.test(c) && !notProcessedCodes.has(c) && c > cityCode && c < upperBound,
  );
}

/** Weighted average of terrain compositions, weighted by validLandMeshCount. */
function mergeTerrainCompositions(
  wards: Array<{ composition: Record<string, number>; weight: number }>,
): Record<string, number> {
  const totalWeight = wards.reduce((s, w) => s + w.weight, 0);
  if (totalWeight === 0) return {};
  const merged: Record<string, number> = {};
  for (const { composition, weight } of wards) {
    const scale = weight / totalWeight;
    for (const [terrain, pct] of Object.entries(composition)) {
      merged[terrain] = (merged[terrain] ?? 0) + pct * scale;
    }
  }
  // Round to 1 decimal
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(merged)) {
    out[k] = Math.round(v * 10) / 10;
  }
  return out;
}

/** Compute ward-averaged score from merged terrain composition + validLandMeshCount weighting. */
function computeWardAveragedScore(wardEntries: RawEntry[]): {
  score: number;
  susceptibleRatio: number;
  highRiskRatio: number;
  maxRiskClass: string | null;
} {
  // Use validLandMeshCount-weighted average of candidates as the quick path
  const totalLand = wardEntries.reduce((s, w) => s + (w.validLandMeshCount ?? 0), 0);
  if (totalLand === 0) {
    return { score: 100, susceptibleRatio: 0, highRiskRatio: 0, maxRiskClass: null };
  }
  let wScore = 0;
  let wSusc  = 0;
  let wHigh  = 0;
  for (const w of wardEntries) {
    const land = w.validLandMeshCount ?? 0;
    if (land === 0) continue;
    const weight = land / totalLand;
    wScore += (w.liquefactionRiskCandidate ?? 100) * weight;
    wSusc  += (w.liquefactionSusceptibleAreaRatio ?? 0) * weight;
    wHigh  += (w.liquefactionHighRiskAreaRatio    ?? 0) * weight;
  }
  const score = Math.max(0, Math.min(100, Math.round(wScore)));
  // Max risk class = terrain with highest risk among all ward entries
  let maxRisk = 0;
  let maxRiskClass: string | null = null;
  for (const w of wardEntries) {
    const cls = w.liquefactionMaxRiskClass;
    if (cls) {
      const r = TERRAIN_RISK[cls] ?? 0;
      if (r > maxRisk) { maxRisk = r; maxRiskClass = cls; }
    }
  }
  return { score, susceptibleRatio: wSusc, highRiskRatio: wHigh, maxRiskClass };
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

export function importLiquefaction(
  inputPath: string,
  muniPath:  string,
): LiquefactionEntry[] {
  if (!fs.existsSync(inputPath)) {
    throw new Error(
      `入力ファイルが見つかりません: ${inputPath}\n` +
      `  npm run score:liquefaction-v1:all を先に実行してください。`,
    );
  }
  // Support both wrapped {metadata, entries} and bare array formats
  const raw = JSON.parse(fs.readFileSync(inputPath, "utf-8")) as
    | { metadata: unknown; entries: RawEntry[] }
    | RawEntry[];
  const rawLiq: RawEntry[] = Array.isArray(raw) ? raw : (raw as { entries: RawEntry[] }).entries;
  console.log(`liquefaction-scores.json: ${rawLiq.length}件`);

  if (!fs.existsSync(muniPath)) {
    throw new Error(`municipalities.json が見つかりません: ${muniPath}`);
  }
  const rawMuni = JSON.parse(
    fs.readFileSync(muniPath, "utf-8"),
  ) as Array<{ jisCode: string }>;
  const muniCodes = new Set(rawMuni.map((m) => m.jisCode));
  console.log(`municipalities.json: ${rawMuni.length}件`);

  // Build map (exclude codes not in municipalities.json)
  const liqMap = new Map<string, RawEntry>();
  const excluded: string[] = [];
  for (const r of rawLiq) {
    if (!muniCodes.has(r.jisCode)) { excluded.push(r.jisCode); continue; }
    liqMap.set(r.jisCode, r);
  }
  if (excluded.length > 0) {
    console.warn(`\n⚠️  municipalities.json に存在しない jisCode を除外 (${excluded.length}件):`);
    for (const c of excluded) console.warn(`  ${c}`);
  }

  const notProcessedCodes = new Set(
    rawLiq.filter((r) => r.liquefactionDataStatus === "not-processed").map((r) => r.jisCode),
  );
  const allLiqCodes = rawLiq.map((r) => r.jisCode);

  const results: LiquefactionEntry[] = [];
  let scoredCount   = 0;
  let noRiskCount   = 0;
  let noAreaCount   = 0;
  let wardAvgCount  = 0;
  let missingCount  = 0;
  const warnings: string[] = [];
  const today = new Date().toISOString().slice(0, 10);

  for (const m of rawMuni) {
    const { jisCode } = m;
    const liq = liqMap.get(jisCode);

    if (!liq) {
      warnings.push(`[${jisCode}] liquefaction-scores.json に存在しません`);
      results.push({
        jisCode,
        liquefactionRiskCandidate:        null,
        liquefactionDataStatus:           "missing",
        liquefactionSusceptibleAreaRatio: null,
        liquefactionHighRiskAreaRatio:    null,
        liquefactionMaxRiskClass:         null,
        liquefactionUpdatedAt:            today,
        liquefactionSource:               DEFAULT_SOURCE,
        liquefactionMethod:               DEFAULT_METHOD,
        terrainComposition:               {},
        validLandMeshCount:               null,
        calculationVersion:               CALC_VERSION,
      });
      missingCount++;
      continue;
    }

    const status = liq.liquefactionDataStatus;

    if (status === "scored" || status === "no-liquefaction-risk" || status === "no-liquefaction-area") {
      results.push({
        jisCode,
        liquefactionRiskCandidate:        liq.liquefactionRiskCandidate,
        liquefactionDataStatus:           status as LiquefactionDataStatus,
        liquefactionSusceptibleAreaRatio: liq.liquefactionSusceptibleAreaRatio,
        liquefactionHighRiskAreaRatio:    liq.liquefactionHighRiskAreaRatio,
        liquefactionMaxRiskClass:         liq.liquefactionMaxRiskClass,
        liquefactionUpdatedAt:            liq.liquefactionUpdatedAt,
        liquefactionSource:               liq.liquefactionSource || DEFAULT_SOURCE,
        liquefactionMethod:               liq.liquefactionMethod  || DEFAULT_METHOD,
        terrainComposition:               liq.terrainComposition  ?? {},
        validLandMeshCount:               liq.validLandMeshCount  ?? null,
        calculationVersion:               CALC_VERSION,
      });
      if (status === "scored")                    scoredCount++;
      else if (status === "no-liquefaction-risk") noRiskCount++;
      else                                         noAreaCount++;
      continue;
    }

    // not-processed → ward-averaged
    const wardCodes = findWardCodes(jisCode, notProcessedCodes, allLiqCodes);
    const wardEntries = wardCodes
      .map((wc) => liqMap.get(wc))
      .filter((e): e is RawEntry => e !== undefined &&
        (e.liquefactionDataStatus === "scored" || e.liquefactionDataStatus === "no-liquefaction-risk"));

    if (wardEntries.length === 0) {
      warnings.push(`[${jisCode}] 区データなし → missing 扱い (wardCandidates=${wardCodes.length})`);
      results.push({
        jisCode,
        liquefactionRiskCandidate:        null,
        liquefactionDataStatus:           "missing",
        liquefactionSusceptibleAreaRatio: null,
        liquefactionHighRiskAreaRatio:    null,
        liquefactionMaxRiskClass:         null,
        liquefactionUpdatedAt:            liq.liquefactionUpdatedAt,
        liquefactionSource:               liq.liquefactionSource || DEFAULT_SOURCE,
        liquefactionMethod:               DEFAULT_METHOD,
        terrainComposition:               {},
        validLandMeshCount:               null,
        calculationVersion:               CALC_VERSION,
      });
      missingCount++;
      continue;
    }

    const { score, susceptibleRatio, highRiskRatio, maxRiskClass } =
      computeWardAveragedScore(wardEntries);

    const terrainComposition = mergeTerrainCompositions(
      wardEntries.map((w) => ({
        composition: w.terrainComposition ?? {},
        weight: w.validLandMeshCount ?? 1,
      })),
    );

    const totalLand = wardEntries.reduce((s, w) => s + (w.validLandMeshCount ?? 0), 0);

    results.push({
      jisCode,
      liquefactionRiskCandidate:        score,
      liquefactionDataStatus:           "ward-averaged",
      liquefactionSusceptibleAreaRatio: Math.round(susceptibleRatio * 10000) / 10000,
      liquefactionHighRiskAreaRatio:    Math.round(highRiskRatio    * 10000) / 10000,
      liquefactionMaxRiskClass:         maxRiskClass,
      liquefactionUpdatedAt:            liq.liquefactionUpdatedAt,
      liquefactionSource:               liq.liquefactionSource || DEFAULT_SOURCE,
      liquefactionMethod:               DEFAULT_METHOD,
      terrainComposition,
      validLandMeshCount:               totalLand,
      calculationVersion:               CALC_VERSION,
    });
    wardAvgCount++;
    console.log(
      `  [${jisCode}] ward-averaged: ${wardEntries.length}区 → score=${score}` +
      ` (range: ${Math.min(...wardEntries.map((w) => w.liquefactionRiskCandidate ?? 100))}` +
      `〜${Math.max(...wardEntries.map((w) => w.liquefactionRiskCandidate ?? 100))})`,
    );
  }

  if (warnings.length > 0) {
    console.warn(`\n⚠️  警告 (${warnings.length}件):`);
    for (const w of warnings) console.warn(`  ${w}`);
  }

  const candidates = results
    .map((r) => r.liquefactionRiskCandidate)
    .filter((v): v is number => v !== null);
  const cMin  = candidates.length > 0 ? Math.min(...candidates) : 0;
  const cMax  = candidates.length > 0 ? Math.max(...candidates) : 0;
  const cMean = candidates.length > 0
    ? (candidates.reduce((a, b) => a + b, 0) / candidates.length).toFixed(1)
    : "—";

  console.log(`\n--- import-liquefaction 統計 ---`);
  console.log(`total                     : ${results.length}件`);
  console.log(`scored                    : ${scoredCount}件`);
  console.log(`no-liquefaction-risk      : ${noRiskCount}件`);
  console.log(`no-liquefaction-area      : ${noAreaCount}件`);
  console.log(`ward-averaged             : ${wardAvgCount}件`);
  console.log(`missing                   : ${missingCount}件`);
  console.log(`\nliquefactionRiskCandidate : min=${cMin} max=${cMax} mean=${cMean}`);

  return results;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (require.main === module) {
  const inputPath  = getArg("--input")  ?? DEFAULT_INPUT;
  const outputPath = getArg("--output") ?? DEFAULT_OUTPUT;

  try {
    const results = importLiquefaction(inputPath, DEFAULT_MUNI_PATH);

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), "utf-8");
    const sizeKb = (fs.statSync(outputPath).size / 1024).toFixed(1);
    console.log(`\n✅ 書き出し完了: ${outputPath} (${results.length}件, ${sizeKb} KB)`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
