/**
 * データセット検証スクリプト
 *
 * 実データ投入後の municipalities.json を検証する。
 * build 前に実行して品質を担保することを推奨。
 *
 * 使い方:
 *   npx ts-node scripts/validate-datasets.ts \
 *     --input src/data/municipalities.json
 *
 * チェック内容:
 *   1. 必須フィールドの存在確認
 *   2. スコアの数値範囲（0〜100）
 *   3. 重複IDの検出
 *   4. overallScore の再計算値との乖離確認
 *   5. Phase3フィールドのカバレッジ確認
 *   6. データ統計サマリー出力
 *   7. 避難所関連フィールドの検証（shelterCapacity / shelterSource / dataUpdatedAt）
 *   8. jisCode カバレッジ（--strict 時は未設定を error 扱い）
 *   9. jisCode 重複検出（常に error）
 *  10. search-index 完全一致検証（件数 + id/prefecture/municipality/overallScore が municipalities.json と一致しない場合 error）
 *  11. shelters.json スキーマ検証（jisCode/sourceUrl/sourceUrls/shelterCount/totalCapacity/sheltersPerTenThousand/capacityPerPopulation/calculationVersion）
 *
 * オプション:
 *   --strict        jisCode 未設定 / processed 未使用 を warning ではなく error として報告
 *   --shelters PATH shelters.json の検証対象パス（デフォルト: data/processed/shelters.json）
 */

import fs from "fs";
import path from "path";
import { calcOverallScore } from "@/lib/score";
import { SCORE_ITEMS } from "@/lib/score";
import type { ScoreKey } from "@/lib/score";

// -------------------------------------------------------
// 型定義
// -------------------------------------------------------

interface Municipality {
  id: string;
  prefecture: string;
  municipality: string;
  overallScore: number;
  floodRisk: number;
  earthquakeRisk: number;
  fireRisk: number;
  agingRisk: number;
  shelterCapacity: number;
  [key: string]: unknown;
}

// -------------------------------------------------------
// バリデーション
// -------------------------------------------------------

interface ValidationResult {
  errors: string[];
  warnings: string[];
  stats: Record<string, number>;
}

const JIS_RE  = /^\d{5}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, mo, d] = s.split("-").map(Number);
  const dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
}

const REQUIRED_FIELDS = [
  "id", "prefecture", "municipality", "overallScore",
  "floodRisk", "earthquakeRisk", "fireRisk", "agingRisk", "shelterCapacity",
  "comment", "actionTips", "sourceNote",
] as const;

const SCORE_FIELDS: ScoreKey[] = SCORE_ITEMS.filter((i) => i.visible).map((i) => i.key);

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function validatePopulationJson(
  populationPath: string,
  masterPath: string,
  strictMode = false,
): { errors: string[]; warnings: string[]; stats: Record<string, number> } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const stats: Record<string, number> = {};

  if (!fs.existsSync(populationPath)) {
    const msg = `population.json が存在しません（スキップ）: ${populationPath}`;
    if (strictMode) {
      errors.push(msg);
    } else {
      warnings.push(msg);
    }
    return { errors, warnings, stats };
  }

  let masterJisCodes: Set<string> | null = null;
  if (!fs.existsSync(masterPath)) {
    const msg = `masterファイルが存在しません（jisCode照合スキップ）: ${masterPath}`;
    if (strictMode) {
      errors.push(msg);
      return { errors, warnings, stats };
    }
    warnings.push(msg);
  } else {
    try {
      const master = JSON.parse(
        fs.readFileSync(masterPath, "utf-8"),
      ) as Array<{ jisCode?: string }>;
      masterJisCodes = new Set(
        master.map((m) => m.jisCode).filter((c): c is string => typeof c === "string"),
      );
    } catch {
      const msg = `master JSON parse 失敗（jisCode照合スキップ）: ${masterPath}`;
      if (strictMode) {
        errors.push(msg);
        return { errors, warnings, stats };
      }
      warnings.push(msg);
    }
  }

  let population: Array<Record<string, unknown>>;
  try {
    population = JSON.parse(fs.readFileSync(populationPath, "utf-8"));
  } catch {
    return { errors: [`population.json JSON parse 失敗: ${populationPath}`], warnings: [], stats: {} };
  }

  if (!Array.isArray(population)) {
    return { errors: [`population.json は配列である必要があります: ${populationPath}`], warnings: [], stats: {} };
  }

  stats["population件数"] = population.length;

  // 0件チェック
  if (population.length === 0) {
    const msg = `population.json が空です (0件)。実データを投入してください`;
    if (strictMode) {
      errors.push(msg);
    } else {
      warnings.push(msg);
    }
    return { errors, warnings, stats };
  }

  // strict mode: master jisCode 件数との coverage チェック
  // 北方領土6村(01695-01700)・双葉町(07546)・浜松市新3区(22138-22140) は
  // e-Stat 2020年国勢調査に含まれない正当な欠損のため最大10件を許容する
  const POPULATION_KNOWN_GAP = 10;
  if (strictMode && masterJisCodes && population.length < masterJisCodes.size - POPULATION_KNOWN_GAP) {
    const missing = masterJisCodes.size - population.length;
    errors.push(
      `population.json の件数 (${population.length}件) が master jisCode 件数 (${masterJisCodes.size}件) を` +
      `${POPULATION_KNOWN_GAP}件超えて下回っています — ${missing}件欠損。` +
      `北方領土・避難自治体・2020年以降新設区を除く全市区町村の人口データが必要です`,
    );
  }

  // jisCode 重複検出（常に error）
  const jisCodeCounts = new Map<string, number>();
  for (const p of population) {
    const jis = p["jisCode"];
    if (typeof jis === "string" && JIS_RE.test(jis)) {
      jisCodeCounts.set(jis, (jisCodeCounts.get(jis) ?? 0) + 1);
    }
  }
  for (const [jis, count] of jisCodeCounts) {
    if (count > 1) {
      errors.push(`population.json jisCode重複: "${jis}" (${count}件)`);
    }
  }

  for (const p of population) {
    const jisCode = p["jisCode"];
    const id = `${jisCode ?? "unknown"}`;

    if (typeof jisCode !== "string" || !JIS_RE.test(jisCode)) {
      errors.push(`[${id}] jisCode が無効 (5桁数字必須): ${jisCode}`);
    } else if (masterJisCodes && !masterJisCodes.has(jisCode)) {
      errors.push(`[${id}] jisCode がmasterに存在しません`);
    }

    // prefecture 必須
    const pref = p["prefecture"];
    if (typeof pref !== "string" || pref.trim() === "") {
      errors.push(`[${id}] prefecture が空または未設定`);
    }

    // municipality 必須
    const muni = p["municipality"];
    if (typeof muni !== "string" || muni.trim() === "") {
      errors.push(`[${id}] municipality が空または未設定`);
    }

    const pop = p["population"];
    if (typeof pop !== "number" || !Number.isFinite(pop) || !Number.isInteger(pop) || pop <= 0) {
      errors.push(`[${id}] population が無効 (正の整数必須): ${pop}`);
    }

    if (!isHttpUrl(p["sourceUrl"])) {
      errors.push(`[${id}] sourceUrl が無効 (http(s) URL必須): ${p["sourceUrl"]}`);
    }

    const updatedAt = p["updatedAt"];
    if (typeof updatedAt !== "string" || !isValidDate(updatedAt)) {
      errors.push(`[${id}] updatedAt が無効 (実在するYYYY-MM-DD必須): ${updatedAt}`);
    }

    if (p["calculationVersion"] !== "population-v1") {
      errors.push(`[${id}] calculationVersion は population-v1 である必要があります (${p["calculationVersion"]})`);
    }
  }

  return { errors, warnings, stats };
}

function validateSheltersJson(
  sheltersPath: string,
  strictMode = false,
): { errors: string[]; warnings: string[]; stats: Record<string, number> } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const stats: Record<string, number> = {};

  if (!fs.existsSync(sheltersPath)) {
    const msg = `shelters.json が存在しません（スキップ）: ${sheltersPath}`;
    if (strictMode) {
      errors.push(msg);
    } else {
      warnings.push(msg);
    }
    return { errors, warnings, stats };
  }

  let shelters: Array<Record<string, unknown>>;
  try {
    shelters = JSON.parse(fs.readFileSync(sheltersPath, "utf-8"));
  } catch {
    return { errors: [`shelters.json JSON parse 失敗: ${sheltersPath}`], warnings: [], stats: {} };
  }

  if (!Array.isArray(shelters)) {
    return { errors: [`shelters.json は配列である必要があります: ${sheltersPath}`], warnings: [], stats: {} };
  }

  stats["shelters件数"] = shelters.length;

  for (const s of shelters) {
    const id = `${s["jisCode"] ?? "unknown"}`;

    // jisCode: 5桁数字必須
    const jisCode = s["jisCode"];
    if (typeof jisCode !== "string" || !JIS_RE.test(jisCode)) {
      errors.push(`[${id}] jisCode が無効 (5桁数字必須): ${jisCode}`);
    }

    // sourceUrl: http(s) URL文字列必須
    const sourceUrl = s["sourceUrl"];
    if (!isHttpUrl(sourceUrl)) {
      errors.push(`[${id}] sourceUrl が無効 (http(s) URL必須): ${sourceUrl}`);
    }

    // sourceUrls: 1件以上の配列、全要素が http(s) URL、sourceUrl を含むこと
    const sourceUrls = s["sourceUrls"];
    if (!Array.isArray(sourceUrls) || sourceUrls.length === 0) {
      errors.push(`[${id}] sourceUrls は1件以上の配列である必要があります`);
    } else {
      for (const url of sourceUrls) {
        if (!isHttpUrl(url)) {
          errors.push(`[${id}] sourceUrls に無効なURLがあります: ${url}`);
        }
      }
      if (typeof sourceUrl === "string" && !sourceUrls.includes(sourceUrl)) {
        errors.push(`[${id}] sourceUrls に sourceUrl が含まれていません: ${sourceUrl}`);
      }
    }

    // shelterCount >= 0
    const sc = s["shelterCount"];
    if (typeof sc !== "number" || sc < 0) {
      errors.push(`[${id}] shelterCount が無効 (${sc})`);
    }

    // totalCapacity >= 0
    const tc = s["totalCapacity"];
    if (typeof tc !== "number" || tc < 0) {
      errors.push(`[${id}] totalCapacity が無効 (${tc})`);
    }

    // sheltersPerTenThousand >= 0 または null
    const spt = s["sheltersPerTenThousand"];
    if (spt !== null && (typeof spt !== "number" || spt < 0)) {
      errors.push(`[${id}] sheltersPerTenThousand が無効 (${spt})`);
    }

    // capacityPerPopulation >= 0 または null
    const cpp = s["capacityPerPopulation"];
    if (cpp !== null && (typeof cpp !== "number" || cpp < 0)) {
      errors.push(`[${id}] capacityPerPopulation が無効 (${cpp})`);
    }

    // calculationVersion: shelter-v1 と完全一致
    if (s["calculationVersion"] !== "shelter-v1") {
      errors.push(`[${id}] calculationVersion は shelter-v1 である必要があります (${s["calculationVersion"]})`);
    }
  }

  return { errors, warnings, stats };
}

function validateDatasets(inputPath: string, strictMode = false, sheltersPath?: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const stats: Record<string, number> = {};

  if (!fs.existsSync(inputPath)) {
    return { errors: [`ファイルが見つかりません: ${inputPath}`], warnings: [], stats: {} };
  }

  let data: Municipality[];
  try {
    data = JSON.parse(fs.readFileSync(inputPath, "utf-8"));
  } catch {
    return { errors: ["JSON パースエラー"], warnings: [], stats: {} };
  }

  stats["総件数"] = data.length;

  // 1. 必須フィールドチェック
  for (const m of data) {
    for (const field of REQUIRED_FIELDS) {
      if (m[field] === undefined || m[field] === null || m[field] === "") {
        errors.push(`[${m.id}] 必須フィールド不足: ${field}`);
      }
    }
  }

  // 2. スコア範囲チェック
  for (const m of data) {
    for (const key of SCORE_FIELDS) {
      const v = m[key];
      if (v === undefined) continue;
      if (typeof v !== "number" || isNaN(v) || v < 0 || v > 100) {
        errors.push(`[${m.id}] ${key}: 範囲外またはNaN (${v})`);
      }
    }
  }

  // 3. 重複IDチェック
  const idCounts = new Map<string, number>();
  for (const m of data) {
    idCounts.set(m.id, (idCounts.get(m.id) ?? 0) + 1);
  }
  for (const [id, count] of idCounts) {
    if (count > 1) errors.push(`重複ID: ${id} (${count}件)`);
  }

  // 4. overallScore の乖離チェック（実データ投入後）
  let largeDeviationCount = 0;
  for (const m of data) {
    const computed = calcOverallScore(m as Partial<Record<ScoreKey, number>>);
    const diff = Math.abs(computed - m.overallScore);
    if (diff > 10) {
      warnings.push(`[${m.id}] overallScore 乖離: 記録値=${m.overallScore}, 再計算値=${computed} (差=${diff})`);
      largeDeviationCount++;
    }
  }
  stats["overallScore乖離10超"] = largeDeviationCount;

  // 5. Phase3フィールドカバレッジ
  const phase3Fields: ScoreKey[] = SCORE_ITEMS
    .filter((i) => i.phase === 3 && i.visible)
    .map((i) => i.key);

  for (const field of phase3Fields) {
    const covered = data.filter((m) => m[field] !== undefined).length;
    stats[`Phase3.${field}カバレッジ`] = covered;
    if (covered === 0) {
      warnings.push(`Phase3フィールド未投入: ${field}`);
    } else if (covered < data.length) {
      warnings.push(`Phase3フィールド不完全: ${field} (${covered}/${data.length})`);
    }
  }

  // 7. 避難所・人口関連フィールドの検証
  let shelterSourceCount = 0;
  let dataUpdatedAtCount = 0;
  let populationCount = 0;

  for (const m of data) {
    // shelterCapacity は 2. のスコア範囲チェックでカバー済み。追加で負数チェック
    const sc = m.shelterCapacity;
    if (typeof sc === "number" && sc < 0) {
      errors.push(`[${m.id}] shelterCapacity が負数 (${sc})`);
    }

    // shelterSource: 存在する場合は文字列であること
    const ss = m["shelterSource"];
    if (ss !== undefined) {
      shelterSourceCount++;
      if (typeof ss !== "string" || ss.trim() === "") {
        errors.push(`[${m.id}] shelterSource が無効な値 (${ss})`);
      }
    }

    // dataUpdatedAt: 存在する場合は YYYY-MM-DD 形式であること
    const da = m["dataUpdatedAt"];
    if (da !== undefined) {
      dataUpdatedAtCount++;
      if (typeof da !== "string" || !DATE_RE.test(da)) {
        errors.push(`[${m.id}] dataUpdatedAt の日付形式が不正 (${da})`);
      }
    }

    // population: 存在する場合は正の整数
    const popVal = m["population"];
    if (popVal !== undefined) {
      if (
        typeof popVal !== "number" ||
        !Number.isFinite(popVal) ||
        !Number.isInteger(popVal) ||
        popVal <= 0
      ) {
        errors.push(`[${m.id}] population が無効 (正の整数必須): ${popVal}`);
      } else {
        populationCount++;
      }
    }

    // populationSource: 存在する場合は http(s) URL
    const popSrc = m["populationSource"];
    if (popSrc !== undefined && !isHttpUrl(popSrc)) {
      errors.push(`[${m.id}] populationSource が無効 (http(s) URL必須): ${popSrc}`);
    }

    // populationUpdatedAt: 存在する場合は実在 YYYY-MM-DD
    const popUpdAt = m["populationUpdatedAt"];
    if (popUpdAt !== undefined) {
      if (typeof popUpdAt !== "string" || !isValidDate(popUpdAt)) {
        errors.push(`[${m.id}] populationUpdatedAt が無効 (実在するYYYY-MM-DD必須): ${popUpdAt}`);
      }
    }
  }

  stats["shelterSource記入済み"]    = shelterSourceCount;
  stats["dataUpdatedAt記入済み"]    = dataUpdatedAtCount;
  stats["population記入済み"]       = populationCount;

  // 8. jisCode カバレッジ（--strict 時は error、通常時は warning）
  let jisCodeCount = 0;
  for (const m of data) {
    const jis = m["jisCode"];
    if (jis !== undefined) {
      jisCodeCount++;
      if (typeof jis !== "string" || !JIS_RE.test(jis)) {
        errors.push(`[${m.id}] jisCode の形式が不正 (5桁数字である必要があります): ${jis}`);
      }
    } else {
      const msg = `[${m.id}] jisCode 未設定 (全国データ投入時に結合精度が低下します)`;
      if (strictMode) {
        errors.push(msg);
      } else {
        warnings.push(msg);
      }
    }
  }
  stats["jisCode設定済み"] = jisCodeCount;
  stats["jisCode未設定"] = data.length - jisCodeCount;

  // 9. jisCode 重複検出（常に error）
  const jisCodeCounts = new Map<string, string[]>();
  for (const m of data) {
    const jis = m["jisCode"];
    if (typeof jis === "string" && jis) {
      const ids = jisCodeCounts.get(jis) ?? [];
      ids.push(m.id);
      jisCodeCounts.set(jis, ids);
    }
  }
  for (const [jis, ids] of jisCodeCounts) {
    if (ids.length > 1) {
      errors.push(`jisCode 重複: ${jis} → [${ids.join(", ")}]`);
    }
  }

  // 10. result URL 重複検証（strict 時は jisCode ベースURLの一意性を保証）
  const resultPathCounts = new Map<string, string[]>();
  for (const m of data) {
    const jis = m["jisCode"];
    if (typeof jis !== "string" || !JIS_RE.test(jis)) continue;
    const pathKey = `/result/${encodeURIComponent(jis)}`;
    const ids = resultPathCounts.get(pathKey) ?? [];
    ids.push(m.id);
    resultPathCounts.set(pathKey, ids);
  }
  for (const [pathKey, ids] of resultPathCounts) {
    if (ids.length > 1) {
      errors.push(`result path 重複: ${pathKey} → [${ids.join(", ")}]`);
    }
  }
  stats["resultPath件数"] = resultPathCounts.size;

  // 11. search-index 完全一致検証（件数 + id / jisCode / prefecture / municipality / overallScore）
  const searchIndexPath = path.join(path.dirname(inputPath), "municipality-search-index.json");
  if (!fs.existsSync(searchIndexPath)) {
    errors.push(`municipality-search-index.json が存在しません: ${searchIndexPath}`);
  } else {
    try {
      const searchIndex = JSON.parse(fs.readFileSync(searchIndexPath, "utf-8")) as Array<{
        id: string;
        jisCode?: string;
        prefecture: string;
        municipality: string;
        overallScore: number;
      }>;

      if (searchIndex.length !== data.length) {
        errors.push(
          `search-index 件数不一致: municipalities.json=${data.length}件 ` +
          `search-index=${searchIndex.length}件 ` +
          `(npm run merge:data を再実行してください)`
        );
      } else {
        stats["searchIndex件数"] = searchIndex.length;

        const dataById = new Map(data.map((m) => [m.id, m]));
        for (const entry of searchIndex) {
          const m = dataById.get(entry.id);
          if (!m) {
            errors.push(`search-index に存在しないid: ${entry.id}`);
            continue;
          }
          if (entry.jisCode !== m.jisCode) {
            errors.push(
              `search-index jisCode 不一致 [${entry.id}]: ` +
              `index=${entry.jisCode} vs municipalities=${m.jisCode}`
            );
          }
          if (entry.prefecture !== m.prefecture) {
            errors.push(
              `search-index prefecture 不一致 [${entry.id}]: ` +
              `index=${entry.prefecture} vs municipalities=${m.prefecture}`
            );
          }
          if (entry.municipality !== m.municipality) {
            errors.push(
              `search-index municipality 不一致 [${entry.id}]: ` +
              `index=${entry.municipality} vs municipalities=${m.municipality}`
            );
          }
          if (entry.overallScore !== m.overallScore) {
            errors.push(
              `search-index overallScore 不一致 [${entry.id}]: ` +
              `index=${entry.overallScore} vs municipalities=${m.overallScore}`
            );
          }
        }
      }
    } catch {
      errors.push(`municipality-search-index.json の JSON parse 失敗`);
    }
  }

  // 6. 統計サマリー
  const overallScores = data.map((m) => m.overallScore).filter((v) => typeof v === "number");
  if (overallScores.length > 0) {
    stats["overallScore最小"] = Math.min(...overallScores);
    stats["overallScore最大"] = Math.max(...overallScores);
    stats["overallScore平均"] = Math.round(overallScores.reduce((a, b) => a + b, 0) / overallScores.length);
  }

  const prefSet = new Set(data.map((m) => m.prefecture));
  stats["都道府県数"] = prefSet.size;

  // 12. shelters.json スキーマ検証（npm スクリプトはプロジェクトルートから実行される前提）
  const resolvedSheltersPath = sheltersPath ?? "data/processed/shelters.json";
  const shelterValidation = validateSheltersJson(resolvedSheltersPath, strictMode);
  errors.push(...shelterValidation.errors);
  warnings.push(...shelterValidation.warnings);
  Object.assign(stats, shelterValidation.stats);

  // 13. population.json スキーマ検証
  const populationValidation = validatePopulationJson(
    "data/processed/population.json",
    "data/master/municipalities-base.json",
    strictMode,
  );
  errors.push(...populationValidation.errors);
  warnings.push(...populationValidation.warnings);
  Object.assign(stats, populationValidation.stats);

  return { errors, warnings, stats };
}

// -------------------------------------------------------
// CLI
// -------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const inputPath   = get("--input")    ?? "src/data/municipalities.json";
  const sheltersPath = get("--shelters");
  const strictMode  = args.includes("--strict");

  if (strictMode) console.log("🔒 STRICT MODE: jisCode 未設定 → error");

  const { errors, warnings, stats } = validateDatasets(inputPath, strictMode, sheltersPath);

  console.log("\n=== データ検証結果 ===");
  console.log(`対象: ${inputPath}\n`);

  if (errors.length > 0) {
    console.error(`エラー (${errors.length}件):`);
    errors.forEach((e) => console.error(`  ❌ ${e}`));
  } else {
    console.log("エラー: なし ✅");
  }

  if (warnings.length > 0) {
    console.warn(`\n警告 (${warnings.length}件):`);
    warnings.forEach((w) => console.warn(`  ⚠️  ${w}`));
  } else {
    console.log("警告: なし ✅");
  }

  console.log("\n統計サマリー:");
  for (const [key, val] of Object.entries(stats)) {
    console.log(`  ${key}: ${val}`);
  }

  if (errors.length > 0) {
    process.exit(1);
  }
}
