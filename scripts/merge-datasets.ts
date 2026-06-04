/**
 * データセット統合スクリプト
 *
 * 各 importer の出力（data/processed/*.json）を統合し、
 * municipalities.json の形式で出力する。
 * merge 完了後、municipality-search-index.json を自動再生成する。
 *
 * デフォルト:
 *   --base      data/master/municipalities-base.json  (master; 手動管理)
 *   --processed data/processed/                       (generated)
 *   --output    src/data/municipalities.json           (generated; Next.js が参照)
 *
 * basePath と outputPath が同じ場合はエラーで終了する（循環防止）。
 *
 * JOIN 優先順位:
 *   1. jisCode（5桁JISコード） ← codeMap
 *   2. municipalityCode        ← codeMap (jisCode が一致しない場合)
 *   3. prefecture_municipality  ← muniMap (fallback; 件数を集計して警告)
 *
 * fail-fast:
 *   - JSON parse 失敗 → throw（ファイル未存在のみ optional 扱い）
 *   - basePath === outputPath → throw
 *
 * processed 未使用検出:
 *   - 各 processed dataset について JOIN 件数と未使用件数を報告
 */

import fs from "fs";
import path from "path";
import { calcOverallScore } from "@/lib/score";
import type { ScoreKey } from "@/lib/score";

// -------------------------------------------------------
// 型定義
// -------------------------------------------------------

interface ScoreEntry {
  municipalityCode?: string;
  jisCode?: string;
  prefecture?: string;
  municipality?: string;
  [scoreKey: string]: number | string | undefined;
}

interface ShelterEntry {
  jisCode: string;
  prefecture: string;
  municipality: string;
  shelterCount: number;
  totalCapacity: number;
  sheltersPerTenThousand: number | null;
  capacityPerPopulation: number | null;
  disasterTypes: string[];
  sourceUrl: string;
  updatedAt: string;
  shelterCapacity: number;
}

interface PopulationEntry {
  jisCode: string;
  prefecture: string;
  municipality: string;
  population: number;
  sourceUrl: string;
  updatedAt: string;
  calculationVersion: string;
}

interface AgingEntry {
  jisCode: string;
  elderlyPopulation: number;
  agingRate?: number;
  agingRisk?: number;
  agingSource?: string;
  agingUpdatedAt?: string;
  calculationVersion: "aging-v1";
}

interface MunicipalityBase {
  id: string;
  jisCode?: string;
  prefecture: string;
  municipality: string;
  [key: string]: unknown;
}

/** 各 processed dataset の JOIN 使用状況 */
interface DatasetUsageStat {
  name: string;
  totalEntries: number;
  joinedCount: number;
  unusedEntries: string[]; // jisCode or "pref_muni" key
}

// -------------------------------------------------------
// ユーティリティ
// -------------------------------------------------------

/**
 * JSON ファイルを読み込む。
 * - ファイル未存在: [] を返す（optional 扱い）
 * - parse 失敗: throw（fail-fast）
 */
function loadJsonIfExists<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf-8");
  try {
    return JSON.parse(raw) as T[];
  } catch (e) {
    throw new Error(`JSON parse 失敗: ${filePath} — ${(e as Error).message}`);
  }
}

function buildMuniKeyMap<T extends { prefecture?: string; municipality?: string }>(
  entries: T[]
): Map<string, T> {
  const map = new Map<string, T>();
  for (const e of entries) {
    map.set(`${e.prefecture ?? ""}_${e.municipality ?? ""}`, e);
  }
  return map;
}

function buildCodeMap<T extends { municipalityCode?: string; jisCode?: string }>(
  entries: T[]
): Map<string, T> {
  const map = new Map<string, T>();
  for (const e of entries) {
    const code = e.jisCode ?? e.municipalityCode;
    if (code) map.set(code, e);
  }
  return map;
}

// -------------------------------------------------------
// JOIN 関数（優先順位: jisCode → municipalityCode → muniKey）
// -------------------------------------------------------

function lookupEntry<T extends ScoreEntry>(
  m: MunicipalityBase,
  muniKey: string,
  codeMap: Map<string, T>,
  muniMap: Map<string, T>,
): { entry: T | undefined; wasFallback: boolean } {
  // Priority 1 & 2: jisCode / municipalityCode → codeMap
  if (m.jisCode) {
    const e = codeMap.get(m.jisCode);
    if (e) return { entry: e, wasFallback: false };
  }
  // Priority 3: prefecture_municipality → muniMap (fallback)
  const e = muniMap.get(muniKey);
  return { entry: e, wasFallback: e !== undefined };
}

// -------------------------------------------------------
// スコアフィールド適用
// -------------------------------------------------------

const SCORE_FIELDS: Array<ScoreKey> = [
  "floodRisk", "earthquakeRisk", "fireRisk",
  "agingRisk", "shelterCapacity",
  "isolationRisk", "childcareStressRisk", "emotionalRecoveryRisk",
  "socialSupportScore", "infrastructureRecoveryScore", "familyDisasterPreparedness",
];

function applyScoreEntry(
  result: Record<string, unknown>,
  entry: ScoreEntry
): void {
  for (const field of SCORE_FIELDS) {
    const v = (entry as Record<string, unknown>)[field];
    if (typeof v === "number" && !isNaN(v)) result[field] = v;
  }
}

// -------------------------------------------------------
// 避難所データの統合（専用ロジック）
// -------------------------------------------------------

function applyShelterEntry(
  result: Record<string, unknown>,
  m: MunicipalityBase,
  shelter: ShelterEntry
): void {
  result["shelterCapacity"]  = shelter.shelterCapacity;
  result["shelterSource"]    = shelter.sourceUrl;
  result["shelterUpdatedAt"] = shelter.updatedAt;

  // socialSupportScore: 既存70% + 避難所スコア30%
  const existingSocial = typeof m.socialSupportScore === "number" ? m.socialSupportScore as number : null;
  result["socialSupportScore"] = existingSocial !== null
    ? Math.round(existingSocial * 0.7 + shelter.shelterCapacity * 0.3)
    : shelter.shelterCapacity;

  // infrastructureRecoveryScore: 既存80% + 避難所スコア20%
  const existingInfra = typeof m.infrastructureRecoveryScore === "number" ? m.infrastructureRecoveryScore as number : null;
  result["infrastructureRecoveryScore"] = existingInfra !== null
    ? Math.round(existingInfra * 0.8 + shelter.shelterCapacity * 0.2)
    : shelter.shelterCapacity;
}

// -------------------------------------------------------
// search-index 生成
// -------------------------------------------------------

interface SearchIndexEntry {
  id: string;
  jisCode: string;
  prefecture: string;
  municipality: string;
  overallScore: number;
}

function generateSearchIndex(
  merged: Record<string, unknown>[],
  outputPath: string
): void {
  const searchIndex: SearchIndexEntry[] = merged.map((m) => ({
    id:           m.id           as string,
    jisCode:      m.jisCode      as string,
    prefecture:   m.prefecture   as string,
    municipality: m.municipality as string,
    overallScore: m.overallScore as number,
  }));

  // 1行1エントリのコンパクト形式で出力
  const json =
    "[\n" +
    searchIndex.map((e) => "  " + JSON.stringify(e)).join(",\n") +
    "\n]\n";

  fs.writeFileSync(outputPath, json, "utf-8");
  console.log(`search-index: ${searchIndex.length}件 -> ${outputPath}`);
}

// -------------------------------------------------------
// メイン統合処理
// -------------------------------------------------------

function mergeDatasets(
  basePath: string,
  processedDir: string,
  outputPath: string,
  strictMode = false,
): void {
  // basePath === outputPath チェック（循環防止）
  if (path.resolve(basePath) === path.resolve(outputPath)) {
    throw new Error(
      `basePath と outputPath が同じファイルを指しています: ${basePath}\n` +
      `master ファイルを data/master/municipalities-base.json に分離してください。`
    );
  }

  // ベースデータ読み込み
  if (!fs.existsSync(basePath)) throw new Error(`base ファイルが見つかりません: ${basePath}`);
  let base: MunicipalityBase[];
  try {
    base = JSON.parse(fs.readFileSync(basePath, "utf-8"));
  } catch (e) {
    throw new Error(`base ファイルの JSON parse 失敗: ${basePath} — ${(e as Error).message}`);
  }
  console.log(`base: ${basePath} (${base.length}件)`);

  // -------------------------------------------------------
  // 汎用 *-scores.json を読み込み（codeMap + muniMap + 使用状況トラッカー）
  // -------------------------------------------------------

  const scoreFileKeys = [
    "flood-scores", "earthquake-scores", "fire-scores",
    "shelter-scores", "population-scores", "landslide-scores",
  ] as const;

  type ScoreFilePair = {
    codeMap: Map<string, ScoreEntry>;
    muniMap: Map<string, ScoreEntry>;
    usage:   DatasetUsageStat;
  };

  const scoreFilePairs: ScoreFilePair[] = scoreFileKeys.map((key) => {
    const fp   = path.join(processedDir, `${key}.json`);
    const data = loadJsonIfExists<ScoreEntry>(fp);
    const name = path.basename(fp);

    // 各エントリのキーを収集（未使用検出用）
    const allKeys = new Set<string>();
    for (const e of data) {
      const code = e.jisCode ?? e.municipalityCode;
      if (code) allKeys.add(code);
      else allKeys.add(`${e.prefecture ?? ""}_${e.municipality ?? ""}`);
    }

    if (data.length > 0) console.log(`読み込み: ${fp} (${data.length}件)`);
    else                  console.warn(`スキップ (未生成): ${fp}`);

    return {
      codeMap: buildCodeMap(data),
      muniMap: buildMuniKeyMap(data),
      usage: {
        name,
        totalEntries: data.length,
        joinedCount:  0,
        unusedEntries: [...allKeys],
      },
    };
  });

  // -------------------------------------------------------
  // shelters.json を読み込み（専用フォーマット）
  // -------------------------------------------------------

  const sheltersPath      = path.join(processedDir, "shelters.json");
  const shelterData       = loadJsonIfExists<ShelterEntry>(sheltersPath);
  const shelterByJisCode  = new Map<string, ShelterEntry>();
  const shelterByMuniKey  = new Map<string, ShelterEntry>();

  const shelterUsage: DatasetUsageStat = {
    name:         path.basename(sheltersPath),
    totalEntries: shelterData.length,
    joinedCount:  0,
    unusedEntries: shelterData.map((s) => s.jisCode),
  };

  if (shelterData.length > 0) {
    console.log(`読み込み: ${sheltersPath} (${shelterData.length}件)`);
    for (const s of shelterData) {
      shelterByJisCode.set(s.jisCode, s);
      shelterByMuniKey.set(`${s.prefecture}_${s.municipality}`, s);
    }
  } else {
    console.warn(`スキップ (未生成): ${sheltersPath}`);
  }

  // -------------------------------------------------------
  // population.json を読み込み（専用フォーマット）
  // -------------------------------------------------------

  const populationPath     = path.join(processedDir, "population.json");
  const populationData     = loadJsonIfExists<PopulationEntry>(populationPath);
  const populationByJisCode = new Map<string, PopulationEntry>();

  if (populationData.length > 0) {
    console.log(`読み込み: ${populationPath} (${populationData.length}件)`);
    for (const p of populationData) {
      populationByJisCode.set(p.jisCode, p);
    }
  } else {
    console.warn(`スキップ (未生成): ${populationPath}`);
  }

  // -------------------------------------------------------
  // aging.json を読み込み（高齢化率・agingRisk 実データ）
  // -------------------------------------------------------

  const agingPath      = path.join(processedDir, "aging.json");
  const agingData      = loadJsonIfExists<AgingEntry>(agingPath);
  const agingByJisCode = new Map<string, AgingEntry>();

  if (agingData.length > 0) {
    console.log(`読み込み: ${agingPath} (${agingData.length}件)`);
    for (const a of agingData) {
      agingByJisCode.set(a.jisCode, a);
    }
  } else {
    console.warn(`スキップ (未生成): ${agingPath}`);
  }

  let agingJoinCount    = 0;
  let agingMissingCount = 0;

  const joinFailureWarnings: string[] = [];
  const missingShelterBaseKeys: string[] = [];
  const usedShelterKeys = new Set<string>();
  let fallbackJoinCount = 0;

  // -------------------------------------------------------
  // 統合ループ
  // -------------------------------------------------------

  const merged = base.map((m) => {
    const muniKey = `${m.prefecture}_${m.municipality}`;
    const result: Record<string, unknown> = { ...m };

    // base 由来の人口系フィールドをクリア（population.json JOIN 成功時のみ再設定）
    // population.json が空・欠損時に古い値が残らないようにする
    delete result["population"];
    delete result["populationSource"];
    delete result["populationUpdatedAt"];

    // 手動 aging 系フィールドをすべてクリア（aging.json JOIN 成功時のみ再設定）
    // base に残った初期値・手動入力値を必ず上書きするため削除してから付与する
    delete result["elderlyPopulation"];
    delete result["agingRate"];
    delete result["agingSource"];
    delete result["agingUpdatedAt"];
    delete result["agingRisk"];

    // 汎用スコアファイルから JOIN
    for (const pair of scoreFilePairs) {
      const { entry, wasFallback } = lookupEntry(m, muniKey, pair.codeMap, pair.muniMap);
      if (!entry) continue;

      if (wasFallback) {
        fallbackJoinCount++;
      }
      applyScoreEntry(result, entry);

      // 使用済みとしてマーク
      const usedKey = (entry.jisCode ?? entry.municipalityCode) ?? muniKey;
      pair.usage.unusedEntries = pair.usage.unusedEntries.filter((k) => k !== usedKey);
      pair.usage.joinedCount++;
    }

    // 避難所データを JOIN（jisCode 優先 → muniKey フォールバック）
    const shelter =
      (m.jisCode ? shelterByJisCode.get(m.jisCode) : undefined) ??
      shelterByMuniKey.get(muniKey);

    if (shelter) {
      applyShelterEntry(result, m, shelter);
      usedShelterKeys.add(shelter.jisCode);
    } else if (shelterData.length > 0) {
      missingShelterBaseKeys.push(muniKey);
    }

    // 人口データを JOIN（jisCode のみ）
    const pop = m.jisCode ? populationByJisCode.get(m.jisCode) : undefined;
    if (pop) {
      result["population"]          = pop.population;
      result["populationSource"]    = pop.sourceUrl;
      result["populationUpdatedAt"] = pop.updatedAt;
    }

    // aging データを JOIN（jisCode のみ）
    // aging.json がある場合は実データで上書き。
    // aging 欠損10件（北方領土・双葉町・浜松市新3区）は population もないため
    // agingRisk を 50（初期設計値）に設定して overallScore 計算を維持する。
    if (agingData.length > 0) {
      const aging = m.jisCode ? agingByJisCode.get(m.jisCode) : undefined;
      if (aging && aging.agingRisk !== undefined) {
        result["elderlyPopulation"] = aging.elderlyPopulation;
        result["agingRate"]         = aging.agingRate;
        result["agingRisk"]         = aging.agingRisk;
        result["agingSource"]       = aging.agingSource;
        result["agingUpdatedAt"]    = aging.agingUpdatedAt;
        agingJoinCount++;
      } else {
        // aging データなし → agingRisk は中立値 50 を維持
        result["agingRisk"] = 50;
        agingMissingCount++;
      }
    }

    // dataUpdatedAt = max(shelterUpdatedAt, populationUpdatedAt)
    // 最新データ更新日を全体の dataUpdatedAt として保持
    const sDate = result["shelterUpdatedAt"];
    const pDate = result["populationUpdatedAt"];
    const dateCandidates = [sDate, pDate].filter((d): d is string => typeof d === "string");
    if (dateCandidates.length > 0) {
      result["dataUpdatedAt"] = dateCandidates.sort().at(-1)!;
    }

    // overallScore 再計算
    const allScores: Partial<Record<ScoreKey, number>> = {};
    for (const field of SCORE_FIELDS) {
      const v = result[field];
      if (typeof v === "number" && !isNaN(v)) allScores[field] = v;
    }
    if (Object.keys(allScores).length > 0) {
      result["overallScore"] = calcOverallScore(allScores);
    }

    return result;
  });

  // -------------------------------------------------------
  // 後処理: 統計・警告出力
  // -------------------------------------------------------

  const strictErrors: string[] = [];

  // fallback JOIN 集計
  if (fallbackJoinCount > 0) {
    const msg =
      `prefecture_municipality フォールバックJOIN: ${fallbackJoinCount}件` +
      ` (jisCode 設定で精度が向上します)`;
    if (strictMode) {
      strictErrors.push(msg);
    } else {
      console.warn(`\n⚠️  ${msg}`);
    }
  }

  // JOIN 失敗 warnings
  if (joinFailureWarnings.length > 0) {
    if (strictMode) {
      strictErrors.push(...joinFailureWarnings);
    } else {
      console.warn(`\n⚠️  JOIN 失敗 (${joinFailureWarnings.length}件):`);
      for (const w of joinFailureWarnings) console.warn(`  ${w}`);
    }
  }

  // processed 未使用検出（shelters.json）
  if (shelterUsage.totalEntries > 0) {
    shelterUsage.unusedEntries = shelterUsage.unusedEntries.filter((k) => !usedShelterKeys.has(k));
    shelterUsage.joinedCount = usedShelterKeys.size;

    console.log(
      `\nshelters.json 使用状況: ` +
      `${shelterUsage.joinedCount}/${shelterUsage.totalEntries}件 JOIN済`
    );
    if (missingShelterBaseKeys.length > 0) {
      console.warn(
        `  ⚠️  master側に避難所データなし: ${missingShelterBaseKeys.length}件 ` +
        `(GSI未提出・行政区粒度差・避難所未公開の可能性。strict停止対象外)`
      );
      console.warn(
        `      例: ${missingShelterBaseKeys.slice(0, 10).join(", ")}` +
        (missingShelterBaseKeys.length > 10 ? " ..." : "")
      );
    }
    if (shelterUsage.unusedEntries.length > 0) {
      const msg =
        `shelters.json 未使用エントリ (${shelterUsage.unusedEntries.length}件): ` +
        shelterUsage.unusedEntries.join(", ");
      if (strictMode) {
        strictErrors.push(msg);
      } else {
        console.warn(`  ⚠️  ${msg}`);
      }
    }
  }

  // 汎用スコアファイルの未使用検出
  for (const pair of scoreFilePairs) {
    if (pair.usage.totalEntries === 0) continue;
    console.log(
      `${pair.usage.name} 使用状況: ` +
      `${pair.usage.joinedCount}/${pair.usage.totalEntries}件 JOIN済`
    );
    if (pair.usage.unusedEntries.length > 0) {
      const msg =
        `${pair.usage.name} 未使用エントリ (${pair.usage.unusedEntries.length}件): ` +
        pair.usage.unusedEntries.slice(0, 10).join(", ") +
        (pair.usage.unusedEntries.length > 10 ? " ..." : "");
      if (strictMode) {
        strictErrors.push(msg);
      } else {
        console.warn(`  ⚠️  ${msg}`);
      }
    }
  }

  // aging.json 統合結果ログ
  if (agingData.length > 0) {
    console.log(
      `\naging.json 使用状況: ${agingJoinCount}/${agingData.length}件 JOIN済` +
      ` / 未反映 ${agingMissingCount}件（agingRisk=50 維持）`,
    );
    const agingRiskVals = merged
      .map((m) => m["agingRisk"])
      .filter((v): v is number => typeof v === "number");
    const arMin  = Math.min(...agingRiskVals);
    const arMax  = Math.max(...agingRiskVals);
    const arMean = agingRiskVals.reduce((s, v) => s + v, 0) / agingRiskVals.length;
    console.log(`  agingRisk range: ${arMin} 〜 ${arMax} (mean: ${arMean.toFixed(2)})`);
  }

  // strict モード: エラーがあれば出力前に終了
  if (strictMode && strictErrors.length > 0) {
    console.error(`\n🔒 STRICT MODE エラー (${strictErrors.length}件):`);
    for (const e of strictErrors) console.error(`  ❌ ${e}`);
    throw new Error("strict モードでエラーが検出されました。処理を中断します。");
  }

  // -------------------------------------------------------
  // 出力: municipalities.json
  // -------------------------------------------------------

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(merged, null, 2), "utf-8");
  console.log(`\nOK: ${merged.length}件を出力 -> ${outputPath}`);

  // -------------------------------------------------------
  // 出力: municipality-search-index.json（自動再生成）
  // -------------------------------------------------------

  const searchIndexPath = path.join(
    path.dirname(outputPath),
    "municipality-search-index.json"
  );
  generateSearchIndex(merged, searchIndexPath);
}

// -------------------------------------------------------
// CLI
// -------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  const get  = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };

  const basePath     = get("--base")      ?? "data/master/municipalities-base.json";
  const processedDir = get("--processed") ?? "data/processed";
  const outputPath   = get("--output")    ?? "src/data/municipalities.json";
  const strictMode   = args.includes("--strict");

  if (strictMode) console.log("🔒 STRICT MODE: フォールバックJOIN・JOIN失敗 → error");

  try {
    mergeDatasets(basePath, processedDir, outputPath, strictMode);
  } catch (e) {
    console.error(`\nERROR: ${(e as Error).message}`);
    process.exit(1);
  }
}
