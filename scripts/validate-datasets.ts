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
 *  12. shelter-sufficiency-v1 フィールド検証（scoreVersion が存在する場合のみ実施）
 *  16. household-v1 フィールド検証（householdRisk / 世帯フィールド / isolationRisk 非破壊 / overallScore 非反映）
 *      - フィールドスキーマ検証
 *      - scoreConfidence 別の整合性チェック
 *      - nationalRank / prefectureRank の dense rank 再計算照合
 *  17. earthquake-v1 フィールド検証（earthquakeRisk / 地震確率 / dataStatus 別整合性）
 *      - earthquakeRisk 10〜90 整数（全自治体必須）
 *      - earthquakeDataStatus 別フィールド整合性チェック
 *      - 件数: direct=1762 / aggregated=19 / known-missing=10 / not-found=127
 *      - earthquakeRisk が overallScore に反映されていないこと（SCORE_FIELDS 除外確認）
 *  18. flood.json スキーマ検証（中間データ / calculationVersion ゲート）
 *      - calculationVersion === "flood-v1"（全エントリ必須）
 *      - floodUpdatedAt 非空 string（全エントリ必須）
 *      - status 別: scored(maxDepthDanger 1〜5 / floodAreaRatio 0〜1)
 *                   no-flood-data(maxDepthDanger=0 / floodAreaRatio=0)
 *                   ward-averaged(floodRiskCandidate number / floodSource string)
 * 18b. flood-v1 フィールド検証（municipalities.json / overallScoreV2 v2.2）
 *      - floodRiskCandidate 10〜90 整数（全自治体必須）
 *      - floodUpdatedAt 非空 string（全自治体必須）
 *      - 件数: scored=1429 / no-flood-data=469 / ward-averaged=20 / missing=0
 *      - floodSource / maxDepthDanger / floodAreaRatio の status 別整合性チェック
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

  // e-Stat 2020年国勢調査に含まれない正当な欠損 jisCode（strict validation で許容）
  // - 北方領土6村: ロシア実効支配・国勢調査対象外
  // - 双葉町(07546): 原発避難・常住人口なし
  // - 浜松市新3区(22138-22140): 2024年1月新設（2020年調査後）
  const KNOWN_MISSING_POPULATION = new Set([
    "01695", "01696", "01697", "01698", "01699", "01700", // 北方領土6村
    "07546",                                               // 双葉町
    "22138", "22139", "22140",                            // 浜松市新3区
  ]);

  let masterJisCodes: Set<string> | null = null;
  let masterNameMap: Map<string, string> | null = null;
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
      ) as Array<{ jisCode?: string; prefecture?: string; municipality?: string }>;
      masterJisCodes = new Set(
        master.map((m) => m.jisCode).filter((c): c is string => typeof c === "string"),
      );
      masterNameMap = new Map(
        master
          .filter((m): m is { jisCode: string; prefecture?: string; municipality?: string } =>
            typeof m.jisCode === "string",
          )
          .map((m) => [m.jisCode, `${m.prefecture ?? ""} ${m.municipality ?? ""}`.trim()]),
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

  // strict mode: allowlist 方式の coverage チェック
  // KNOWN_MISSING_POPULATION に含まれる jisCode の欠損のみ許容する
  if (strictMode && masterJisCodes) {
    const populationJisCodes = new Set(
      population
        .map((p) => p["jisCode"])
        .filter((c): c is string => typeof c === "string"),
    );
    const unexpectedMissing = [...masterJisCodes].filter(
      (c) => !populationJisCodes.has(c) && !KNOWN_MISSING_POPULATION.has(c),
    );
    if (unexpectedMissing.length > 0) {
      const detail = unexpectedMissing
        .slice(0, 20)
        .map((c) => `${c} (${masterNameMap?.get(c) ?? "?"})`)
        .join(", ");
      errors.push(
        `population.json に想定外の欠損 ${unexpectedMissing.length}件: ${detail}` +
        (unexpectedMissing.length > 20 ? ` ...他${unexpectedMissing.length - 20}件` : ""),
      );
    }
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

// -------------------------------------------------------
// shelter-sufficiency-v1 検証
// -------------------------------------------------------

function computeDenseRank(
  entries: Array<{ jisCode: string; score: number }>,
): Map<string, number> {
  const sorted = [...entries].sort(
    (a, b) => b.score - a.score || a.jisCode.localeCompare(b.jisCode),
  );
  const rankMap = new Map<string, number>();
  let rank = 0;
  let prevScore: number | null = null;
  for (const e of sorted) {
    if (e.score !== prevScore) {
      rank++;
      prevScore = e.score;
    }
    rankMap.set(e.jisCode, rank);
  }
  return rankMap;
}

function validateShelterSufficiencyV1(
  data: Municipality[],
): { errors: string[]; warnings: string[]; stats: Record<string, number> } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const stats: Record<string, number> = {};

  const v1Entries = data.filter((m) => m["scoreVersion"] === "shelter-sufficiency-v1");

  if (v1Entries.length === 0) {
    warnings.push(
      "shelter-sufficiency-v1 フィールド未投入 (npm run score:shelter-v1 -- --output src/data/municipalities.json を実行してください)",
    );
    return { errors, warnings, stats };
  }

  if (v1Entries.length !== data.length) {
    errors.push(
      `shelter-sufficiency-v1 フィールドが一部エントリのみに設定されています (${v1Entries.length}/${data.length}件)`,
    );
  }

  stats["v1フィールド件数"] = v1Entries.length;

  const VALID_CONFIDENCE = new Set(["high", "no-shelter-data", "no-data"]);
  let highCount = 0;
  let noShelterCount = 0;
  let noDataCount = 0;

  for (const m of v1Entries) {
    const id = String(m["id"] ?? m["jisCode"] ?? "unknown");

    // --- フィールドスキーマ ---

    const shelterCount = m["shelterCount"];
    if (
      shelterCount !== null &&
      (typeof shelterCount !== "number" ||
        !Number.isInteger(shelterCount) ||
        shelterCount < 0)
    ) {
      errors.push(`[${id}] shelterCount が無効 (>=0 の整数または null): ${shelterCount}`);
    }

    const per10k = m["shelterCountPer10k"];
    if (per10k !== null && (typeof per10k !== "number" || per10k < 0)) {
      errors.push(`[${id}] shelterCountPer10k が無効 (>=0 の数値または null): ${per10k}`);
    }

    const shelterScore = m["shelterScore"];
    if (shelterScore !== null) {
      if (
        typeof shelterScore !== "number" ||
        !Number.isInteger(shelterScore) ||
        shelterScore < 10 ||
        shelterScore > 90
      ) {
        errors.push(`[${id}] shelterScore が無効 (10〜90 の整数または null): ${shelterScore}`);
      }
    }

    const nationalRank = m["nationalRank"];
    if (
      nationalRank !== null &&
      (typeof nationalRank !== "number" ||
        !Number.isInteger(nationalRank) ||
        nationalRank < 1)
    ) {
      errors.push(`[${id}] nationalRank が無効 (正の整数または null): ${nationalRank}`);
    }

    const prefectureRank = m["prefectureRank"];
    if (
      prefectureRank !== null &&
      (typeof prefectureRank !== "number" ||
        !Number.isInteger(prefectureRank) ||
        prefectureRank < 1)
    ) {
      errors.push(`[${id}] prefectureRank が無効 (正の整数または null): ${prefectureRank}`);
    }

    const dc = m["dataCompleteness"];
    let hasPopulation: unknown;
    let hasShelterData: unknown;
    if (!dc || typeof dc !== "object" || Array.isArray(dc)) {
      errors.push(`[${id}] dataCompleteness が欠損または無効型`);
    } else {
      const dcObj = dc as Record<string, unknown>;
      hasPopulation = dcObj["hasPopulation"];
      hasShelterData = dcObj["hasShelterData"];
      if (typeof hasPopulation !== "boolean") {
        errors.push(`[${id}] dataCompleteness.hasPopulation が boolean でありません: ${hasPopulation}`);
      }
      if (typeof hasShelterData !== "boolean") {
        errors.push(`[${id}] dataCompleteness.hasShelterData が boolean でありません: ${hasShelterData}`);
      }
    }

    const conf = m["scoreConfidence"];
    if (typeof conf !== "string" || !VALID_CONFIDENCE.has(conf)) {
      errors.push(`[${id}] scoreConfidence が無効 (high/no-shelter-data/no-data のいずれか): ${conf}`);
      continue;
    }

    // --- 整合性チェック ---

    if (conf === "high") {
      highCount++;
      if (hasPopulation !== true)
        errors.push(`[${id}] scoreConfidence=high だが dataCompleteness.hasPopulation が true でありません`);
      if (hasShelterData !== true)
        errors.push(`[${id}] scoreConfidence=high だが dataCompleteness.hasShelterData が true でありません`);
      if (shelterCount === null)
        errors.push(`[${id}] scoreConfidence=high だが shelterCount が null`);
      if (per10k === null)
        errors.push(`[${id}] scoreConfidence=high だが shelterCountPer10k が null`);
      if (shelterScore === null)
        errors.push(`[${id}] scoreConfidence=high だが shelterScore が null`);
      if (nationalRank === null)
        errors.push(`[${id}] scoreConfidence=high だが nationalRank が null`);
      if (prefectureRank === null)
        errors.push(`[${id}] scoreConfidence=high だが prefectureRank が null`);
    } else if (conf === "no-shelter-data") {
      noShelterCount++;
      if (hasPopulation !== true)
        errors.push(`[${id}] scoreConfidence=no-shelter-data だが dataCompleteness.hasPopulation が true でありません`);
      if (hasShelterData !== false)
        errors.push(`[${id}] scoreConfidence=no-shelter-data だが dataCompleteness.hasShelterData が false でありません`);
      if (shelterCount !== null)
        errors.push(`[${id}] scoreConfidence=no-shelter-data だが shelterCount が null でありません (${shelterCount})`);
      if (per10k !== null)
        errors.push(`[${id}] scoreConfidence=no-shelter-data だが shelterCountPer10k が null でありません`);
      if (shelterScore !== null)
        errors.push(`[${id}] scoreConfidence=no-shelter-data だが shelterScore が null でありません`);
      if (nationalRank !== null)
        errors.push(`[${id}] scoreConfidence=no-shelter-data だが nationalRank が null でありません`);
      if (prefectureRank !== null)
        errors.push(`[${id}] scoreConfidence=no-shelter-data だが prefectureRank が null でありません`);
    } else {
      // no-data
      noDataCount++;
      if (hasPopulation !== false)
        errors.push(`[${id}] scoreConfidence=no-data だが dataCompleteness.hasPopulation が false でありません`);
      if (per10k !== null)
        errors.push(`[${id}] scoreConfidence=no-data だが shelterCountPer10k が null でありません`);
      if (shelterScore !== null)
        errors.push(`[${id}] scoreConfidence=no-data だが shelterScore が null でありません`);
      if (nationalRank !== null)
        errors.push(`[${id}] scoreConfidence=no-data だが nationalRank が null でありません`);
      if (prefectureRank !== null)
        errors.push(`[${id}] scoreConfidence=no-data だが prefectureRank が null でありません`);
    }
  }

  stats["v1スコア対象(high)"] = highCount;
  stats["v1 no-shelter-data"] = noShelterCount;
  stats["v1 no-data"] = noDataCount;

  // --- ランキング検証 ---

  // high 件数 == nationalRank !== null 件数
  const rankedByNational = v1Entries.filter((m) => m["nationalRank"] !== null);
  if (rankedByNational.length !== highCount) {
    errors.push(
      `nationalRank 設定件数 (${rankedByNational.length}) が scoreConfidence=high 件数 (${highCount}) と不一致`,
    );
  }

  // no-shelter-data / no-data がランキングに混入していないか
  const leakedRanks = v1Entries.filter(
    (m) =>
      m["nationalRank"] !== null &&
      (m["scoreConfidence"] === "no-shelter-data" || m["scoreConfidence"] === "no-data"),
  );
  if (leakedRanks.length > 0) {
    errors.push(
      `no-shelter-data / no-data エントリに nationalRank が設定されています (${leakedRanks.length}件)`,
    );
  }

  // nationalRank の dense rank 再計算照合
  const scorable = v1Entries
    .filter((m) => m["shelterScore"] !== null && m["jisCode"])
    .map((m) => ({
      jisCode: String(m["jisCode"]),
      id: String(m["id"] ?? m["jisCode"]),
      score: m["shelterScore"] as number,
      storedNationalRank: m["nationalRank"] as number,
      prefecture: String(m["prefecture"]),
      storedPrefectureRank: m["prefectureRank"] as number,
    }));

  const expectedNationalRank = computeDenseRank(
    scorable.map((e) => ({ jisCode: e.jisCode, score: e.score })),
  );

  let nationalRankMismatch = 0;
  for (const e of scorable) {
    const expected = expectedNationalRank.get(e.jisCode);
    if (expected !== e.storedNationalRank) {
      nationalRankMismatch++;
      if (nationalRankMismatch <= 10) {
        errors.push(
          `[${e.id}] nationalRank 不一致: 期待=${expected}, 実際=${e.storedNationalRank} (score=${e.score})`,
        );
      }
    }
  }
  if (nationalRankMismatch > 10) {
    errors.push(`...nationalRank 不一致 他 ${nationalRankMismatch - 10}件`);
  }
  stats["nationalRank不一致件数"] = nationalRankMismatch;

  // prefectureRank の dense rank 再計算照合
  const byPref = new Map<string, Array<{ jisCode: string; score: number }>>();
  for (const e of scorable) {
    if (!byPref.has(e.prefecture)) byPref.set(e.prefecture, []);
    byPref.get(e.prefecture)!.push({ jisCode: e.jisCode, score: e.score });
  }

  const expectedPrefRankMap = new Map<string, number>();
  for (const [pref, entries] of byPref) {
    const prefRank = computeDenseRank(entries);
    for (const [jisCode, rank] of prefRank) {
      expectedPrefRankMap.set(jisCode, rank);
    }
    void pref;
  }

  let prefRankMismatch = 0;
  for (const e of scorable) {
    const expected = expectedPrefRankMap.get(e.jisCode);
    if (expected !== e.storedPrefectureRank) {
      prefRankMismatch++;
      if (prefRankMismatch <= 10) {
        errors.push(
          `[${e.id}] prefectureRank 不一致: 期待=${expected}, 実際=${e.storedPrefectureRank} (${e.prefecture}, score=${e.score})`,
        );
      }
    }
  }
  if (prefRankMismatch > 10) {
    errors.push(`...prefectureRank 不一致 他 ${prefRankMismatch - 10}件`);
  }
  stats["prefectureRank不一致件数"] = prefRankMismatch;

  return { errors, warnings, stats };
}

// -------------------------------------------------------
// aging-v1 フィールド検証
// -------------------------------------------------------

const KNOWN_AGING_MISSING = new Set([
  "01695", "01696", "01697", "01698", "01699", "01700", // 北方領土
  "07546",                                               // 双葉町
  "22138", "22139", "22140",                             // 浜松市新3区
]);

function validateAgingV1(
  data: Municipality[],
): { errors: string[]; warnings: string[]; stats: Record<string, number | string> } {
  const errors:   string[] = [];
  const warnings: string[] = [];
  const stats: Record<string, number | string> = {};

  let agingReflected  = 0;
  let agingMissing    = 0;
  let unknownMissing  = 0;

  for (const m of data) {
    const id        = String(m["jisCode"] ?? m["id"] ?? "unknown");
    const hasPopulation = typeof m["population"] === "number" && (m["population"] as number) > 0;
    const isKnownMissing = KNOWN_AGING_MISSING.has(id);

    const elderlyPop   = m["elderlyPopulation"];
    const agingRate    = m["agingRate"];
    const agingRisk    = m["agingRisk"];
    const agingSource  = m["agingSource"];
    const agingUpdAt   = m["agingUpdatedAt"];

    // -------------------------------------------------------
    // agingRisk: 全自治体で必須（10〜90 整数）
    // -------------------------------------------------------
    if (agingRisk === undefined || agingRisk === null) {
      errors.push(`[${id}] agingRisk が未設定 (全自治体必須)`);
    } else if (
      typeof agingRisk !== "number" ||
      !Number.isInteger(agingRisk) ||
      agingRisk < 10 || agingRisk > 90
    ) {
      errors.push(`[${id}] agingRisk が無効 (10〜90 整数必須): ${agingRisk}`);
    } else if (isKnownMissing && agingRisk !== 50) {
      errors.push(`[${id}] population 欠損自治体の agingRisk は 50 必須: ${agingRisk}`);
    }

    // -------------------------------------------------------
    // population なし / 既知欠損 → aging フィールド未設定許容
    // -------------------------------------------------------
    if (!hasPopulation) {
      if (elderlyPop !== undefined && elderlyPop !== null) {
        errors.push(`[${id}] population なしで elderlyPopulation が設定されています: ${elderlyPop}`);
      }
      agingMissing++;
      if (!isKnownMissing) unknownMissing++;
      continue;
    }

    // -------------------------------------------------------
    // population あり → 以下フィールドは必須
    // -------------------------------------------------------

    const population = m["population"] as number;

    // elderlyPopulation
    if (elderlyPop === undefined || elderlyPop === null) {
      errors.push(`[${id}] elderlyPopulation が未設定 (population あり自治体は必須)`);
    } else if (
      typeof elderlyPop !== "number" ||
      !Number.isInteger(elderlyPop) ||
      elderlyPop < 0
    ) {
      errors.push(`[${id}] elderlyPopulation が無効 (0以上整数必須): ${elderlyPop}`);
    } else if (elderlyPop > population) {
      errors.push(
        `[${id}] elderlyPopulation (${elderlyPop}) > population (${population})`,
      );
    }

    // agingRate
    if (agingRate === undefined || agingRate === null) {
      errors.push(`[${id}] agingRate が未設定 (population あり自治体は必須)`);
    } else if (typeof agingRate !== "number" || agingRate < 0 || agingRate > 100) {
      errors.push(`[${id}] agingRate が無効 (0〜100 必須): ${agingRate}`);
    } else if (
      typeof elderlyPop === "number" &&
      typeof population === "number" &&
      population > 0
    ) {
      const expected = (elderlyPop / population) * 100;
      if (Math.abs((agingRate as number) - expected) > 0.1) {
        errors.push(
          `[${id}] agingRate 不一致: 格納値=${agingRate}, 算出値=${expected.toFixed(4)}` +
          ` (elderlyPopulation=${elderlyPop}, population=${population})`,
        );
      }
    }

    // 手動データ残留チェック: agingRate があるが agingSource がない
    if (
      agingRate !== undefined && agingRate !== null &&
      (agingSource === undefined || agingSource === null)
    ) {
      errors.push(
        `[${id}] agingRate が設定されているが agingSource がありません (手動データ残留の可能性)`,
      );
    }

    // agingSource
    if (agingSource === undefined || agingSource === null) {
      errors.push(`[${id}] agingSource が未設定 (population あり自治体は必須)`);
    } else if (!isHttpUrl(agingSource)) {
      errors.push(`[${id}] agingSource が http(s) URL ではありません: ${agingSource}`);
    }

    // agingUpdatedAt
    if (agingUpdAt === undefined || agingUpdAt === null) {
      errors.push(`[${id}] agingUpdatedAt が未設定 (population あり自治体は必須)`);
    } else if (typeof agingUpdAt !== "string" || !isValidDate(agingUpdAt)) {
      errors.push(`[${id}] agingUpdatedAt が無効 (実在 YYYY-MM-DD 必須): ${agingUpdAt}`);
    }

    agingReflected++;
  }

  // -------------------------------------------------------
  // coverage チェック
  // -------------------------------------------------------
  stats["aging反映件数"]     = agingReflected;
  stats["aging欠損件数"]     = agingMissing;
  stats["aging未知欠損件数"] = unknownMissing;

  if (agingReflected !== 1908) {
    errors.push(
      `aging 反映件数が期待値と異なります: ${agingReflected}件 (期待: 1908件)`,
    );
  }

  if (agingMissing !== 10) {
    errors.push(
      `aging 欠損件数が期待値と異なります: ${agingMissing}件 (期待: 10件)`,
    );
  }

  if (unknownMissing > 0) {
    errors.push(
      `aging 未知欠損が ${unknownMissing}件あります (既知欠損 10件に含まれない自治体)`,
    );
  }

  // agingRisk 統計
  const agingRiskVals = data
    .map((m) => m["agingRisk"])
    .filter((v): v is number => typeof v === "number");
  if (agingRiskVals.length > 0) {
    stats["agingRisk最小"] = Math.min(...agingRiskVals);
    stats["agingRisk最大"] = Math.max(...agingRiskVals);
    stats["agingRisk平均"] = Math.round(
      agingRiskVals.reduce((s, v) => s + v, 0) / agingRiskVals.length,
    );
  }

  return { errors, warnings, stats };
}

// -------------------------------------------------------
// household-v1 フィールド検証
// -------------------------------------------------------

const KNOWN_HOUSEHOLD_MISSING = new Set([
  "01695", "01696", "01697", "01698", "01699", "01700", // 北方領土
  "07546",                                               // 双葉町
  "22138", "22139", "22140",                             // 浜松市新3区
]);

const EXPECTED_HOUSEHOLD_UPDATED_AT = "2021-11-30";

function validateHouseholdV1(
  data: Municipality[],
): { errors: string[]; warnings: string[]; stats: Record<string, number | string> } {
  const errors:   string[] = [];
  const warnings: string[] = [];
  const stats: Record<string, number | string> = {};

  let householdReflected = 0;
  let householdMissing   = 0;
  let unknownMissing     = 0;

  // -------------------------------------------------------
  // (11) overallScore 非反映確認
  // householdRisk が SCORE_ITEMS に含まれていないことを検証
  // -------------------------------------------------------
  const scoreItemKeys = SCORE_ITEMS.map((i) => i.key as string);
  if (scoreItemKeys.includes("householdRisk")) {
    errors.push(
      "householdRisk が SCORE_ITEMS に含まれています。overallScore に反映されてしまいます（意図しない変更）",
    );
  }

  for (const m of data) {
    const id             = String(m["jisCode"] ?? m["id"] ?? "unknown");
    const isKnownMissing = KNOWN_HOUSEHOLD_MISSING.has(id);

    const total     = m["totalGeneralHouseholds"];
    const single    = m["elderlySingleHouseholds"];
    const couple    = m["elderlyCoupleHouseholds"];
    const singleRate = m["elderlySingleRate"];
    const coupleRate = m["elderlyCoupleRate"];
    const hRisk      = m["householdRisk"];
    const hSource    = m["householdSource"];
    const hUpdAt     = m["householdUpdatedAt"];

    // -------------------------------------------------------
    // (7) householdRisk: 全自治体で必須（10〜90 整数）
    // -------------------------------------------------------
    if (hRisk === undefined || hRisk === null) {
      errors.push(`[${id}] householdRisk が未設定 (全自治体必須)`);
    } else if (
      typeof hRisk !== "number" ||
      !Number.isInteger(hRisk) ||
      hRisk < 10 || hRisk > 90
    ) {
      errors.push(`[${id}] householdRisk が無効 (10〜90 整数必須): ${hRisk}`);
    } else if (isKnownMissing && hRisk !== 50) {
      errors.push(`[${id}] household 欠損自治体の householdRisk は 50 必須: ${hRisk}`);
    }

    // -------------------------------------------------------
    // (10) isolationRisk 非破壊確認（10〜90 整数）
    // -------------------------------------------------------
    const isoRisk = m["isolationRisk"];
    if (isoRisk !== undefined && isoRisk !== null) {
      if (
        typeof isoRisk !== "number" ||
        !Number.isInteger(isoRisk) ||
        isoRisk < 10 || isoRisk > 90
      ) {
        errors.push(`[${id}] isolationRisk が無効 (10〜90 整数必須): ${isoRisk}`);
      }
    }

    // -------------------------------------------------------
    // 既知欠損 → 世帯フィールド未設定許容
    // -------------------------------------------------------
    if (isKnownMissing) {
      // 欠損自治体に世帯フィールドが残っていたらエラー
      if (total !== undefined && total !== null)
        errors.push(`[${id}] household 欠損自治体に totalGeneralHouseholds が設定されています`);
      householdMissing++;
      continue;
    }

    // -------------------------------------------------------
    // household 反映自治体 → 以下フィールドは必須
    // -------------------------------------------------------

    // (2) totalGeneralHouseholds
    if (total === undefined || total === null) {
      errors.push(`[${id}] totalGeneralHouseholds が未設定 (household 反映自治体は必須)`);
      unknownMissing++;
      continue; // 以後の整合性チェックはスキップ
    }
    if (typeof total !== "number" || !Number.isInteger(total) || total <= 0) {
      errors.push(`[${id}] totalGeneralHouseholds が無効 (正整数必須): ${total}`);
    }

    // (3) elderlySingleHouseholds
    if (single === undefined || single === null) {
      errors.push(`[${id}] elderlySingleHouseholds が未設定 (household 反映自治体は必須)`);
    } else if (typeof single !== "number" || !Number.isInteger(single) || single < 0) {
      errors.push(`[${id}] elderlySingleHouseholds が無効 (0以上整数必須): ${single}`);
    } else if (typeof total === "number" && single > total) {
      errors.push(`[${id}] elderlySingleHouseholds (${single}) > totalGeneralHouseholds (${total})`);
    }

    // (4) elderlyCoupleHouseholds
    if (couple === undefined || couple === null) {
      errors.push(`[${id}] elderlyCoupleHouseholds が未設定 (household 反映自治体は必須)`);
    } else if (typeof couple !== "number" || !Number.isInteger(couple) || couple < 0) {
      errors.push(`[${id}] elderlyCoupleHouseholds が無効 (0以上整数必須): ${couple}`);
    } else if (typeof total === "number" && couple > total) {
      errors.push(`[${id}] elderlyCoupleHouseholds (${couple}) > totalGeneralHouseholds (${total})`);
    }

    // (5) elderlySingleRate
    if (singleRate === undefined || singleRate === null) {
      errors.push(`[${id}] elderlySingleRate が未設定 (household 反映自治体は必須)`);
    } else if (typeof singleRate !== "number" || singleRate < 0 || singleRate > 100) {
      errors.push(`[${id}] elderlySingleRate が無効 (0〜100 必須): ${singleRate}`);
    } else if (
      typeof single === "number" &&
      typeof total === "number" &&
      total > 0
    ) {
      const expected = (single / total) * 100;
      if (Math.abs(singleRate - expected) > 0.1) {
        errors.push(
          `[${id}] elderlySingleRate 不一致: 格納値=${singleRate}, 算出値=${expected.toFixed(4)}` +
          ` (elderlySingleHouseholds=${single}, total=${total})`,
        );
      }
    }

    // (6) elderlyCoupleRate
    if (coupleRate === undefined || coupleRate === null) {
      errors.push(`[${id}] elderlyCoupleRate が未設定 (household 反映自治体は必須)`);
    } else if (typeof coupleRate !== "number" || coupleRate < 0 || coupleRate > 100) {
      errors.push(`[${id}] elderlyCoupleRate が無効 (0〜100 必須): ${coupleRate}`);
    } else if (
      typeof couple === "number" &&
      typeof total === "number" &&
      total > 0
    ) {
      const expected = (couple / total) * 100;
      if (Math.abs(coupleRate - expected) > 0.1) {
        errors.push(
          `[${id}] elderlyCoupleRate 不一致: 格納値=${coupleRate}, 算出値=${expected.toFixed(4)}` +
          ` (elderlyCoupleHouseholds=${couple}, total=${total})`,
        );
      }
    }

    // (8) householdSource
    if (hSource === undefined || hSource === null) {
      errors.push(`[${id}] householdSource が未設定 (household 反映自治体は必須)`);
    } else if (!isHttpUrl(hSource)) {
      errors.push(`[${id}] householdSource が http(s) URL ではありません: ${hSource}`);
    }

    // (9) householdUpdatedAt
    if (hUpdAt === undefined || hUpdAt === null) {
      errors.push(`[${id}] householdUpdatedAt が未設定 (household 反映自治体は必須)`);
    } else if (typeof hUpdAt !== "string" || !isValidDate(hUpdAt)) {
      errors.push(`[${id}] householdUpdatedAt が無効 (実在 YYYY-MM-DD 必須): ${hUpdAt}`);
    } else if (hUpdAt !== EXPECTED_HOUSEHOLD_UPDATED_AT) {
      errors.push(
        `[${id}] householdUpdatedAt が期待値と異なります: ${hUpdAt} (期待: ${EXPECTED_HOUSEHOLD_UPDATED_AT})`,
      );
    }

    householdReflected++;
  }

  // -------------------------------------------------------
  // (1) coverage チェック
  // -------------------------------------------------------
  stats["household反映件数"]     = householdReflected;
  stats["household欠損件数"]     = householdMissing;
  stats["household未知欠損件数"] = unknownMissing;

  if (householdReflected !== 1908) {
    errors.push(
      `household 反映件数が期待値と異なります: ${householdReflected}件 (期待: 1908件)`,
    );
  }

  if (householdMissing !== 10) {
    errors.push(
      `household 欠損件数が期待値と異なります: ${householdMissing}件 (期待: 10件)`,
    );
  }

  if (unknownMissing > 0) {
    errors.push(
      `household 未知欠損が ${unknownMissing}件あります (既知欠損 10件に含まれない自治体)`,
    );
  }

  // householdRisk 統計
  const hrVals = data
    .map((m) => m["householdRisk"])
    .filter((v): v is number => typeof v === "number");
  if (hrVals.length > 0) {
    stats["householdRisk最小"] = Math.min(...hrVals);
    stats["householdRisk最大"] = Math.max(...hrVals);
    stats["householdRisk平均"] = Math.round(
      hrVals.reduce((s, v) => s + v, 0) / hrVals.length,
    );
  }

  return { errors, warnings, stats };
}

// -------------------------------------------------------
// earthquake-v1 フィールド検証
// -------------------------------------------------------

const KNOWN_EARTHQUAKE_MISSING = new Set([
  "01695", "01696", "01697", "01698", "01699", "01700", // 北方領土
  "07546",                                               // 双葉町
  "22138", "22139", "22140",                             // 浜松市新3区
]);

const VALID_EARTHQUAKE_STATUSES = new Set([
  "direct", "aggregated-from-wards", "known-missing", "not-found",
]);

const VALID_EARTHQUAKE_METHODS = new Set([
  "direct", "ward-average", "neutral-fallback",
]);

const EXPECTED_EARTHQUAKE_COUNTS = {
  direct:             1762,
  "aggregated-from-wards": 19,
  "known-missing":    10,
  "not-found":        127,
  total:              1918,
} as const;

function validateEarthquakeV1(
  data: Municipality[],
): { errors: string[]; warnings: string[]; stats: Record<string, number | string> } {
  const errors:   string[] = [];
  const warnings: string[] = [];
  const stats: Record<string, number | string> = {};

  // -------------------------------------------------------
  // overallScore 非反映確認:
  //   (a) earthquakeRisk が SCORE_ITEMS に残っていること（UI 表示用）
  //   (b) 実際の overallScore が earthquakeRisk を除外して計算されていること
  //       → merge-datasets.ts の SCORE_FIELDS と同定義で再計算し一致を確認
  // -------------------------------------------------------
  const scoreItemKeys = SCORE_ITEMS.map((i) => i.key as string);
  if (!scoreItemKeys.includes("earthquakeRisk")) {
    errors.push(
      "earthquakeRisk が SCORE_ITEMS から削除されています。UI 表示に影響します（意図しない変更）",
    );
  }

  // merge-datasets.ts の SCORE_FIELDS と同一定義（earthquakeRisk を含まない）
  const MERGE_SCORE_FIELDS: ScoreKey[] = [
    "floodRisk", "fireRisk",
    "agingRisk", "shelterCapacity",
    "isolationRisk", "childcareStressRisk", "emotionalRecoveryRisk",
    "socialSupportScore", "infrastructureRecoveryScore", "familyDisasterPreparedness",
  ];

  // 定義ミス防止: この配列に earthquakeRisk が混入していたら即エラー
  if ((MERGE_SCORE_FIELDS as string[]).includes("earthquakeRisk")) {
    errors.push(
      "MERGE_SCORE_FIELDS に earthquakeRisk が含まれています（validate-datasets.ts の定義ミス）",
    );
  }

  // 全自治体の overallScore が earthquakeRisk 除外計算と一致することを確認
  let overallScoreMismatch = 0;
  for (const m of data) {
    const id = String(m["jisCode"] ?? m["id"] ?? "unknown");
    const scoresWithoutEq: Partial<Record<ScoreKey, number>> = {};
    for (const field of MERGE_SCORE_FIELDS) {
      const v = m[field];
      if (typeof v === "number" && !isNaN(v)) scoresWithoutEq[field] = v;
    }
    const expected = calcOverallScore(scoresWithoutEq);
    const stored   = m.overallScore;
    if (expected !== stored) {
      overallScoreMismatch++;
      if (overallScoreMismatch <= 5) {
        errors.push(
          `[${id}] overallScore が earthquakeRisk 除外計算と不一致: ` +
          `stored=${stored}, expected=${expected}`,
        );
      }
    }
  }
  if (overallScoreMismatch > 5) {
    errors.push(`...overallScore 不一致 他 ${overallScoreMismatch - 5}件`);
  }
  stats["overallScore-earthquakeRisk除外不一致"] = overallScoreMismatch;

  const statusCounts: Record<string, number> = {
    direct: 0,
    "aggregated-from-wards": 0,
    "known-missing": 0,
    "not-found": 0,
  };

  let reflected = 0; // direct + aggregated (real probability data)
  let neutral   = 0; // known-missing + not-found (earthquakeRisk=50)

  for (const m of data) {
    const id             = String(m["jisCode"] ?? m["id"] ?? "unknown");
    const isKnownMissing = KNOWN_EARTHQUAKE_MISSING.has(id);
    const dataStatus     = m["earthquakeDataStatus"];
    const prob           = m["earthquakeProbability"];
    const method         = m["earthquakeProbabilityMethod"];
    const eqRisk         = m["earthquakeRisk"];
    const eqVersion      = m["earthquakeVersion"];
    const eqSource       = m["earthquakeSource"];
    const eqUpdAt        = m["earthquakeUpdatedAt"];

    // -------------------------------------------------------
    // earthquakeRisk: 全自治体で必須（10〜90 整数）
    // -------------------------------------------------------
    if (eqRisk === undefined || eqRisk === null) {
      errors.push(`[${id}] earthquakeRisk が未設定 (全自治体必須)`);
    } else if (
      typeof eqRisk !== "number" ||
      !Number.isInteger(eqRisk) ||
      eqRisk < 10 || eqRisk > 90
    ) {
      errors.push(`[${id}] earthquakeRisk が無効 (10〜90 整数必須): ${eqRisk}`);
    }

    // -------------------------------------------------------
    // earthquakeDataStatus: 全自治体で必須（enum チェック）
    // -------------------------------------------------------
    if (typeof dataStatus !== "string" || !VALID_EARTHQUAKE_STATUSES.has(dataStatus)) {
      errors.push(
        `[${id}] earthquakeDataStatus が無効 (${[...VALID_EARTHQUAKE_STATUSES].join("|")} 必須): ${dataStatus}`,
      );
      continue; // dataStatus が不正な場合、以後の整合性チェックはスキップ
    }

    statusCounts[dataStatus] = (statusCounts[dataStatus] ?? 0) + 1;

    // -------------------------------------------------------
    // earthquakeProbabilityMethod: 全自治体で必須（enum チェック）
    // -------------------------------------------------------
    if (typeof method !== "string" || !VALID_EARTHQUAKE_METHODS.has(method)) {
      errors.push(
        `[${id}] earthquakeProbabilityMethod が無効 (${[...VALID_EARTHQUAKE_METHODS].join("|")} 必須): ${method}`,
      );
    }

    // -------------------------------------------------------
    // earthquakeVersion: 全自治体で Y2020 必須
    // -------------------------------------------------------
    if (eqVersion !== "Y2020") {
      errors.push(`[${id}] earthquakeVersion が無効 ("Y2020" 必須): ${eqVersion}`);
    }

    // -------------------------------------------------------
    // earthquakeSource: 全自治体で非空文字列必須
    // -------------------------------------------------------
    if (typeof eqSource !== "string" || eqSource.trim() === "") {
      errors.push(`[${id}] earthquakeSource が未設定または空 (全自治体必須)`);
    }

    // -------------------------------------------------------
    // earthquakeUpdatedAt: 全自治体で実在 YYYY-MM-DD 必須
    // -------------------------------------------------------
    if (typeof eqUpdAt !== "string" || !isValidDate(eqUpdAt)) {
      errors.push(`[${id}] earthquakeUpdatedAt が無効 (実在 YYYY-MM-DD 必須): ${eqUpdAt}`);
    }

    // -------------------------------------------------------
    // dataStatus 別の整合性チェック
    // -------------------------------------------------------

    if (dataStatus === "direct" || dataStatus === "aggregated-from-wards") {
      reflected++;

      // probability: 0〜1 の数値必須
      if (typeof prob !== "number" || prob < 0 || prob > 1) {
        errors.push(
          `[${id}] earthquakeProbability: ${dataStatus} では 0〜1 の数値必須 (${prob})`,
        );
      }

      // method 整合性
      const expectedMethod = dataStatus === "direct" ? "direct" : "ward-average";
      if (method !== expectedMethod) {
        errors.push(
          `[${id}] earthquakeProbabilityMethod: ${dataStatus} では "${expectedMethod}" 必須 (${method})`,
        );
      }

      // aggregated 専用フィールド
      if (dataStatus === "aggregated-from-wards") {
        const srcCodes  = m["earthquakeSourceJisCodes"];
        const wardCount = m["earthquakeWardCount"];
        const probMin   = m["earthquakeProbabilityMin"];
        const probMax   = m["earthquakeProbabilityMax"];

        if (!Array.isArray(srcCodes) || srcCodes.length === 0) {
          errors.push(`[${id}] earthquakeSourceJisCodes が未設定または空配列 (aggregated-from-wards 必須)`);
        }
        if (typeof wardCount !== "number" || !Number.isInteger(wardCount) || wardCount < 1) {
          errors.push(`[${id}] earthquakeWardCount が無効 (正整数必須): ${wardCount}`);
        }
        if (Array.isArray(srcCodes) && typeof wardCount === "number" && srcCodes.length !== wardCount) {
          errors.push(
            `[${id}] earthquakeSourceJisCodes.length (${srcCodes.length}) と earthquakeWardCount (${wardCount}) が不一致`,
          );
        }
        if (typeof probMin !== "number" || probMin < 0 || probMin > 1) {
          errors.push(`[${id}] earthquakeProbabilityMin が無効 (0〜1 必須): ${probMin}`);
        }
        if (typeof probMax !== "number" || probMax < 0 || probMax > 1) {
          errors.push(`[${id}] earthquakeProbabilityMax が無効 (0〜1 必須): ${probMax}`);
        }
        if (
          typeof prob === "number" && typeof probMin === "number" && typeof probMax === "number" &&
          (prob < probMin - 0.00001 || prob > probMax + 0.00001)
        ) {
          errors.push(
            `[${id}] earthquakeProbability (${prob}) が min (${probMin}) ~ max (${probMax}) の範囲外`,
          );
        }
      }

    } else {
      // known-missing or not-found
      neutral++;

      // probability: null 必須
      if (prob !== null) {
        errors.push(
          `[${id}] earthquakeProbability: ${dataStatus} では null 必須 (${prob})`,
        );
      }

      // earthquakeRisk: 中立値 50 必須
      if (typeof eqRisk === "number" && eqRisk !== 50) {
        errors.push(
          `[${id}] earthquakeRisk: ${dataStatus} では 50 (中立値) 必須 (${eqRisk})`,
        );
      }

      // method
      if (method !== "neutral-fallback") {
        errors.push(
          `[${id}] earthquakeProbabilityMethod: ${dataStatus} では "neutral-fallback" 必須 (${method})`,
        );
      }

      // known-missing: KNOWN_EARTHQUAKE_MISSING に含まれること
      if (dataStatus === "known-missing" && !isKnownMissing) {
        errors.push(
          `[${id}] earthquakeDataStatus=known-missing だが KNOWN_EARTHQUAKE_MISSING に含まれていません`,
        );
      }
    }
  }

  // -------------------------------------------------------
  // 件数チェック
  // -------------------------------------------------------
  stats["earthquake直接データ件数"]     = statusCounts["direct"] ?? 0;
  stats["earthquake集計データ件数"]     = statusCounts["aggregated-from-wards"] ?? 0;
  stats["earthquake既知欠損件数"]       = statusCounts["known-missing"] ?? 0;
  stats["earthquake未取得件数"]         = statusCounts["not-found"] ?? 0;
  stats["earthquake実データ件数"]       = reflected;
  stats["earthquake中立値件数"]         = neutral;

  const total = reflected + neutral;
  if (total !== EXPECTED_EARTHQUAKE_COUNTS.total) {
    errors.push(
      `earthquake 合計件数が期待値と異なります: ${total}件 (期待: ${EXPECTED_EARTHQUAKE_COUNTS.total}件)`,
    );
  }

  for (const [status, expected] of Object.entries(EXPECTED_EARTHQUAKE_COUNTS)) {
    if (status === "total") continue;
    const actual = statusCounts[status] ?? 0;
    if (actual !== expected) {
      errors.push(
        `earthquake dataStatus="${status}" 件数が期待値と異なります: ${actual}件 (期待: ${expected}件)`,
      );
    }
  }

  // -------------------------------------------------------
  // earthquakeRisk 統計
  // -------------------------------------------------------
  const eqRiskVals = data
    .map((m) => m["earthquakeRisk"])
    .filter((v): v is number => typeof v === "number");
  if (eqRiskVals.length > 0) {
    stats["earthquakeRisk最小"] = Math.min(...eqRiskVals);
    stats["earthquakeRisk最大"] = Math.max(...eqRiskVals);
    stats["earthquakeRisk平均"] = Math.round(
      eqRiskVals.reduce((s, v) => s + v, 0) / eqRiskVals.length,
    );
  }

  // -------------------------------------------------------
  // earthquakeProbability 統計（実データのみ）
  // -------------------------------------------------------
  const probVals = data
    .map((m) => m["earthquakeProbability"])
    .filter((v): v is number => typeof v === "number");
  if (probVals.length > 0) {
    stats["earthquakeProbability最小"] = Math.min(...probVals).toFixed(5);
    stats["earthquakeProbability最大"] = Math.max(...probVals).toFixed(5);
  }

  return { errors, warnings, stats };
}

// -------------------------------------------------------
// flood.json スキーマ検証（calculationVersion を含む中間データ）
// -------------------------------------------------------

function validateFloodJson(
  floodPath: string,
  strictMode = false,
): { errors: string[]; warnings: string[]; stats: Record<string, number | string> } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const stats: Record<string, number | string> = {};

  if (!fs.existsSync(floodPath)) {
    const msg = `flood.json が存在しません（スキップ）: ${floodPath}`;
    if (strictMode) {
      errors.push(msg);
    } else {
      warnings.push(msg);
    }
    return { errors, warnings, stats };
  }

  let flood: Array<Record<string, unknown>>;
  try {
    flood = JSON.parse(fs.readFileSync(floodPath, "utf-8"));
  } catch {
    return { errors: [`flood.json JSON parse 失敗: ${floodPath}`], warnings: [], stats: {} };
  }

  if (!Array.isArray(flood)) {
    return { errors: [`flood.json は配列である必要があります: ${floodPath}`], warnings: [], stats: {} };
  }

  stats["flood.json件数"] = flood.length;

  const statusCounts: Record<string, number> = { scored: 0, "no-flood-data": 0, "ward-averaged": 0 };

  for (const f of flood) {
    const id = `${f["jisCode"] ?? "unknown"}`;

    if (typeof f["jisCode"] !== "string" || !JIS_RE.test(f["jisCode"] as string)) {
      errors.push(`[${id}] jisCode が無効 (5桁数字必須): ${f["jisCode"]}`);
    }

    // calculationVersion: flood.json で保証するゲート
    if (f["calculationVersion"] !== "flood-v1") {
      errors.push(`[${id}] calculationVersion は flood-v1 である必要があります (${f["calculationVersion"]})`);
    }

    const floodUpdatedAt = f["floodUpdatedAt"];
    if (typeof floodUpdatedAt !== "string" || (floodUpdatedAt as string).trim() === "") {
      errors.push(`[${id}] floodUpdatedAt が未設定または空 (全エントリ必須): ${floodUpdatedAt}`);
    }

    const status = f["floodDataStatus"];
    if (typeof status !== "string" || !VALID_FLOOD_STATUSES.has(status)) {
      errors.push(
        `[${id}] floodDataStatus が無効 (${[...VALID_FLOOD_STATUSES].join("|")} 必須): ${status}`,
      );
      continue;
    }
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;

    if (status === "scored") {
      const maxDepthDanger = f["maxDepthDanger"];
      if (
        typeof maxDepthDanger !== "number" ||
        !Number.isInteger(maxDepthDanger) ||
        maxDepthDanger < 1 ||
        maxDepthDanger > 5
      ) {
        errors.push(`[${id}] scored の maxDepthDanger が無効 (1〜5 整数必須): ${maxDepthDanger}`);
      }
      const floodAreaRatio = f["floodAreaRatio"];
      if (
        typeof floodAreaRatio !== "number" ||
        !Number.isFinite(floodAreaRatio) ||
        floodAreaRatio < 0 ||
        floodAreaRatio > 1
      ) {
        errors.push(`[${id}] scored の floodAreaRatio が無効 (0.0〜1.0 の number 必須): ${floodAreaRatio}`);
      }
    } else if (status === "no-flood-data") {
      if (f["maxDepthDanger"] !== 0) {
        errors.push(`[${id}] no-flood-data の maxDepthDanger は 0 必須 (${f["maxDepthDanger"]})`);
      }
      if (f["floodAreaRatio"] !== 0) {
        errors.push(`[${id}] no-flood-data の floodAreaRatio は 0 必須 (${f["floodAreaRatio"]})`);
      }
    } else if (status === "ward-averaged") {
      if (typeof f["floodRiskCandidate"] !== "number") {
        errors.push(`[${id}] ward-averaged の floodRiskCandidate は number 必須: ${f["floodRiskCandidate"]}`);
      }
      if (typeof f["floodSource"] !== "string" || (f["floodSource"] as string).trim() === "") {
        errors.push(`[${id}] ward-averaged の floodSource は必須: ${f["floodSource"]}`);
      }
    }
  }

  stats["flood.json.scored件数"]         = statusCounts.scored;
  stats["flood.json.no-flood-data件数"]  = statusCounts["no-flood-data"];
  stats["flood.json.ward-averaged件数"]  = statusCounts["ward-averaged"];

  return { errors, warnings, stats };
}

// -------------------------------------------------------
// landslide.json スキーマ検証（calculationVersion を含む中間データ）
// -------------------------------------------------------

const VALID_LANDSLIDE_STATUSES = new Set([
  "scored",
  "no-landslide-data",
  "ward-averaged",
  "missing",
]);

function validateLandslideJson(
  landslidePath: string,
): { errors: string[]; warnings: string[]; stats: Record<string, number | string> } {
  const errors:   string[] = [];
  const warnings: string[] = [];
  const stats: Record<string, number | string> = {};

  if (!fs.existsSync(landslidePath)) {
    warnings.push(
      `landslide.json が存在しません（スキップ）: ${landslidePath}` +
      ` (npm run import:landslide を実行してください)`,
    );
    return { errors, warnings, stats };
  }

  let landslide: Array<Record<string, unknown>>;
  try {
    landslide = JSON.parse(fs.readFileSync(landslidePath, "utf-8"));
  } catch {
    return { errors: [`landslide.json JSON parse 失敗: ${landslidePath}`], warnings: [], stats: {} };
  }

  if (!Array.isArray(landslide)) {
    return { errors: [`landslide.json は配列である必要があります: ${landslidePath}`], warnings: [], stats: {} };
  }

  stats["landslide.json件数"] = landslide.length;

  const statusCounts: Record<string, number> = {
    scored: 0, "no-landslide-data": 0, "ward-averaged": 0, missing: 0,
  };

  for (const l of landslide) {
    const id = `${l["jisCode"] ?? "unknown"}`;

    if (typeof l["jisCode"] !== "string" || !JIS_RE.test(l["jisCode"] as string)) {
      errors.push(`[${id}] jisCode が無効 (5桁数字必須): ${l["jisCode"]}`);
    }

    if (l["calculationVersion"] !== "landslide-v1") {
      errors.push(`[${id}] calculationVersion は landslide-v1 である必要があります (${l["calculationVersion"]})`);
    }

    const landUpdatedAt = l["landslideUpdatedAt"];
    if (typeof landUpdatedAt !== "string" || (landUpdatedAt as string).trim() === "") {
      errors.push(`[${id}] landslideUpdatedAt が未設定または空 (全エントリ必須): ${landUpdatedAt}`);
    }

    const status = l["landslideDataStatus"];
    if (typeof status !== "string" || !VALID_LANDSLIDE_STATUSES.has(status)) {
      errors.push(
        `[${id}] landslideDataStatus が無効 (${[...VALID_LANDSLIDE_STATUSES].join("|")} 必須): ${status}`,
      );
      continue;
    }
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;

    const candidate = l["landslideRiskCandidate"];
    if (status !== "missing") {
      if (
        typeof candidate !== "number" ||
        !Number.isInteger(candidate) ||
        candidate < 10 ||
        candidate > 90
      ) {
        errors.push(`[${id}] landslideRiskCandidate が無効 (10〜90 整数必須): ${candidate}`);
      }
    } else if (candidate !== null) {
      errors.push(`[${id}] missing の landslideRiskCandidate は null 必須: ${candidate}`);
    }

    if (status === "scored") {
      const areaRatio = l["landslideAreaRatio"];
      if (
        typeof areaRatio !== "number" ||
        !Number.isFinite(areaRatio) ||
        areaRatio < 0 ||
        areaRatio > 1
      ) {
        errors.push(`[${id}] scored の landslideAreaRatio が無効 (0.0〜1.0 必須): ${areaRatio}`);
      }
    } else if (status === "ward-averaged") {
      if (typeof candidate !== "number") {
        errors.push(`[${id}] ward-averaged の landslideRiskCandidate は number 必須: ${candidate}`);
      }
    }
  }

  stats["landslide.json.scored件数"]           = statusCounts.scored;
  stats["landslide.json.no-landslide-data件数"] = statusCounts["no-landslide-data"];
  stats["landslide.json.ward-averaged件数"]     = statusCounts["ward-averaged"];
  stats["landslide.json.missing件数"]           = statusCounts.missing;

  return { errors, warnings, stats };
}

// -------------------------------------------------------
// tsunami.json スキーマ検証（calculationVersion を含む中間データ）
// -------------------------------------------------------

const VALID_TSUNAMI_JSON_STATUSES = new Set([
  "scored", "no-tsunami-data", "no-tsunami-risk", "ward-averaged", "missing",
]);

function validateTsunamiJson(
  tsunamiPath: string,
): { errors: string[]; warnings: string[]; stats: Record<string, number | string> } {
  const errors:   string[] = [];
  const warnings: string[] = [];
  const stats: Record<string, number | string> = {};

  if (!fs.existsSync(tsunamiPath)) {
    warnings.push(
      `tsunami.json が存在しません（スキップ）: ${tsunamiPath}` +
      ` (npm run import:tsunami を実行してください)`,
    );
    return { errors, warnings, stats };
  }

  let tsunami: Array<Record<string, unknown>>;
  try {
    tsunami = JSON.parse(fs.readFileSync(tsunamiPath, "utf-8"));
  } catch {
    return { errors: [`tsunami.json JSON parse 失敗: ${tsunamiPath}`], warnings: [], stats: {} };
  }

  if (!Array.isArray(tsunami)) {
    return { errors: [`tsunami.json は配列である必要があります: ${tsunamiPath}`], warnings: [], stats: {} };
  }

  stats["tsunami.json件数"] = tsunami.length;

  const statusCounts: Record<string, number> = {
    scored: 0, "no-tsunami-data": 0, "no-tsunami-risk": 0, "ward-averaged": 0, missing: 0,
  };

  for (const t of tsunami) {
    const id = `${t["jisCode"] ?? "unknown"}`;

    if (typeof t["jisCode"] !== "string" || !JIS_RE.test(t["jisCode"] as string)) {
      errors.push(`[${id}] jisCode が無効 (5桁数字必須): ${t["jisCode"]}`);
    }

    if (t["calculationVersion"] !== "tsunami-v1") {
      errors.push(`[${id}] calculationVersion は tsunami-v1 である必要があります (${t["calculationVersion"]})`);
    }

    const tsunUpdatedAt = t["tsunamiUpdatedAt"];
    if (typeof tsunUpdatedAt !== "string" || (tsunUpdatedAt as string).trim() === "") {
      errors.push(`[${id}] tsunamiUpdatedAt が未設定または空 (全エントリ必須): ${tsunUpdatedAt}`);
    }

    const status = t["tsunamiDataStatus"];
    if (typeof status !== "string" || !VALID_TSUNAMI_JSON_STATUSES.has(status)) {
      errors.push(
        `[${id}] tsunamiDataStatus が無効 (${[...VALID_TSUNAMI_JSON_STATUSES].join("|")} 必須): ${status}`,
      );
      continue;
    }
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;

    const candidate = t["tsunamiRiskCandidate"];
    if (status !== "missing") {
      if (
        typeof candidate !== "number" ||
        !Number.isInteger(candidate) ||
        candidate < 0 ||
        candidate > 100
      ) {
        errors.push(`[${id}] tsunamiRiskCandidate が無効 (0〜100 整数必須): ${candidate}`);
      }
    } else if (candidate !== null) {
      errors.push(`[${id}] missing の tsunamiRiskCandidate は null 必須: ${candidate}`);
    }

    if (status === "no-tsunami-risk" && candidate !== 100) {
      errors.push(`[${id}] no-tsunami-risk の tsunamiRiskCandidate は 100 必須: ${candidate}`);
    }
    if (status === "no-tsunami-data" && candidate !== 90 && candidate !== 100) {
      errors.push(`[${id}] no-tsunami-data の tsunamiRiskCandidate は 90 または 100 必須: ${candidate}`);
    }

    if (status === "scored") {
      const areaRatio = t["tsunamiAreaRatio"];
      if (
        typeof areaRatio !== "number" ||
        !Number.isFinite(areaRatio) ||
        areaRatio < 0 ||
        areaRatio > 1
      ) {
        errors.push(`[${id}] scored の tsunamiAreaRatio が無効 (0.0〜1.0 必須): ${areaRatio}`);
      }
    }
  }

  stats["tsunami.json.scored件数"]          = statusCounts.scored;
  stats["tsunami.json.no-tsunami-data件数"] = statusCounts["no-tsunami-data"];
  stats["tsunami.json.no-tsunami-risk件数"] = statusCounts["no-tsunami-risk"];
  stats["tsunami.json.ward-averaged件数"]   = statusCounts["ward-averaged"];
  stats["tsunami.json.missing件数"]         = statusCounts.missing;

  return { errors, warnings, stats };
}

// -------------------------------------------------------
// flood-v1 フィールド検証
// -------------------------------------------------------

const VALID_FLOOD_STATUSES = new Set([
  "scored",
  "no-flood-data",
  "ward-averaged",
]);

const EXPECTED_FLOOD_COUNTS = {
  scored:          1429,
  "no-flood-data": 469,
  "ward-averaged": 20,
  missing:         0,
  total:           1918,
} as const;

function validateFloodV1(
  data: Municipality[],
): { errors: string[]; warnings: string[]; stats: Record<string, number | string> } {
  const errors:   string[] = [];
  const warnings: string[] = [];
  const stats: Record<string, number | string> = {};

  if (data.length !== EXPECTED_FLOOD_COUNTS.total) {
    errors.push(
      `municipalities 件数が期待値と異なります: ${data.length}件 ` +
      `(期待: ${EXPECTED_FLOOD_COUNTS.total}件)`,
    );
  }

  const statusCounts: Record<string, number> = {
    scored: 0,
    "no-flood-data": 0,
    "ward-averaged": 0,
    missing: 0,
  };

  let candidateCount = 0;
  let sourceCount    = 0;
  let v2Count        = 0;
  const candidateVals: number[] = [];

  for (const m of data) {
    const id = String(m["jisCode"] ?? m["id"] ?? "unknown");

    const candidate = m["floodRiskCandidate"];
    if (
      typeof candidate !== "number" ||
      !Number.isInteger(candidate) ||
      candidate < 10 ||
      candidate > 90
    ) {
      errors.push(`[${id}] floodRiskCandidate が無効 (10〜90 整数必須): ${candidate}`);
    } else {
      candidateCount++;
      candidateVals.push(candidate);
    }

    // floodUpdatedAt: 全自治体で非空 string 必須
    const floodUpdatedAt = m["floodUpdatedAt"];
    if (typeof floodUpdatedAt !== "string" || floodUpdatedAt.trim() === "") {
      errors.push(`[${id}] floodUpdatedAt が未設定または空 (全自治体必須): ${floodUpdatedAt}`);
    }

    const status = m["floodDataStatus"];
    if (status === "missing") {
      statusCounts.missing++;
      errors.push(`[${id}] floodDataStatus=missing は許容されません`);
    } else if (typeof status !== "string" || !VALID_FLOOD_STATUSES.has(status)) {
      errors.push(
        `[${id}] floodDataStatus が無効 ` +
        `(${[...VALID_FLOOD_STATUSES].join("|")} 必須): ${status}`,
      );
    } else {
      statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    }

    if (typeof status === "string" && VALID_FLOOD_STATUSES.has(status)) {
      const source = m["floodSource"];
      if (typeof source !== "string" || source.trim() === "") {
        errors.push(`[${id}] floodSource が未設定または空 (${status} では必須): ${source}`);
      } else {
        sourceCount++;
      }
    }

    if (status === "ward-averaged") {
      if (typeof candidate !== "number") {
        errors.push(`[${id}] ward-averaged の floodRiskCandidate は number 必須: ${candidate}`);
      }
      const source = m["floodSource"];
      if (typeof source !== "string" || source.trim() === "") {
        errors.push(`[${id}] ward-averaged の floodSource は必須: ${source}`);
      }
    }

    if (status === "scored") {
      const maxDepthDanger = m["maxDepthDanger"];
      if (
        typeof maxDepthDanger !== "number" ||
        !Number.isInteger(maxDepthDanger) ||
        maxDepthDanger < 1 ||
        maxDepthDanger > 5
      ) {
        errors.push(`[${id}] scored の maxDepthDanger が無効 (1〜5 整数必須): ${maxDepthDanger}`);
      }
      const floodAreaRatio = m["floodAreaRatio"];
      if (
        typeof floodAreaRatio !== "number" ||
        !Number.isFinite(floodAreaRatio) ||
        floodAreaRatio < 0 ||
        floodAreaRatio > 1
      ) {
        errors.push(`[${id}] scored の floodAreaRatio が無効 (0.0〜1.0 の number 必須): ${floodAreaRatio}`);
      }
    } else if (status === "no-flood-data") {
      if (m["maxDepthDanger"] !== 0) {
        errors.push(`[${id}] no-flood-data の maxDepthDanger は 0 必須 (${m["maxDepthDanger"]})`);
      }
      if (m["floodAreaRatio"] !== 0) {
        errors.push(`[${id}] no-flood-data の floodAreaRatio は 0 必須 (${m["floodAreaRatio"]})`);
      }
    }

    const overallScoreV2 = m["overallScoreV2"];
    if (typeof overallScoreV2 !== "number" || !Number.isInteger(overallScoreV2)) {
      errors.push(`[${id}] overallScoreV2 が未設定または無効 (整数必須): ${overallScoreV2}`);
    } else {
      v2Count++;
    }

    if (m["overallScoreV2Version"] !== "v2.2") {
      errors.push(
        `[${id}] overallScoreV2Version が無効 ("v2.2" 必須): ${m["overallScoreV2Version"]}`,
      );
    }
  }

  stats["floodRiskCandidate件数"]   = candidateCount;
  stats["floodSource件数"]          = sourceCount;
  stats["flood.scored件数"]         = statusCounts.scored ?? 0;
  stats["flood.no-flood-data件数"]  = statusCounts["no-flood-data"] ?? 0;
  stats["flood.ward-averaged件数"]  = statusCounts["ward-averaged"] ?? 0;
  stats["flood.missing件数"]        = statusCounts.missing ?? 0;
  stats["overallScoreV2.v2.2件数"] = v2Count;

  if (candidateCount !== EXPECTED_FLOOD_COUNTS.total) {
    errors.push(
      `floodRiskCandidate 件数が期待値と異なります: ${candidateCount}件 ` +
      `(期待: ${EXPECTED_FLOOD_COUNTS.total}件)`,
    );
  }

  for (const [status, expected] of Object.entries(EXPECTED_FLOOD_COUNTS)) {
    if (status === "total") continue;
    const actual = statusCounts[status] ?? 0;
    if (actual !== expected) {
      errors.push(
        `floodDataStatus="${status}" 件数が期待値と異なります: ${actual}件 ` +
        `(期待: ${expected}件)`,
      );
    }
  }

  if (v2Count !== EXPECTED_FLOOD_COUNTS.total) {
    errors.push(
      `overallScoreV2 件数が期待値と異なります: ${v2Count}件 ` +
      `(期待: ${EXPECTED_FLOOD_COUNTS.total}件)`,
    );
  }

  if (candidateVals.length > 0) {
    stats["floodRiskCandidate最小"] = Math.min(...candidateVals);
    stats["floodRiskCandidate最大"] = Math.max(...candidateVals);
    stats["floodRiskCandidate平均"] = Math.round(
      candidateVals.reduce((s, v) => s + v, 0) / candidateVals.length,
    );
  }

  return { errors, warnings, stats };
}

// -------------------------------------------------------
// landslide-v1 フィールド検証（municipalities.json）
// -------------------------------------------------------

function validateLandslideV1(
  data: Municipality[],
): { errors: string[]; warnings: string[]; stats: Record<string, number | string> } {
  const errors:   string[] = [];
  const warnings: string[] = [];
  const stats: Record<string, number | string> = {};

  // landslide フィールドが未投入の場合はスキップ（国土全体スコアリング未実施）
  const withLandslide = data.filter((m) => m["landslideRiskCandidate"] !== undefined);
  if (withLandslide.length === 0) {
    warnings.push(
      "landslideRiskCandidate フィールド未投入 (npm run import:landslide を実行してください)",
    );
    return { errors, warnings, stats };
  }

  stats["landslide投入件数"] = withLandslide.length;

  const statusCounts: Record<string, number> = {
    scored: 0, "no-landslide-data": 0, "ward-averaged": 0, missing: 0,
  };
  const candidateVals: number[] = [];
  let sourceCount = 0;

  for (const m of data) {
    const id = String(m["jisCode"] ?? m["id"] ?? "unknown");

    const candidate = m["landslideRiskCandidate"];
    if (candidate === undefined) continue;

    if (
      typeof candidate !== "number" ||
      !Number.isInteger(candidate) ||
      candidate < 10 ||
      candidate > 90
    ) {
      if (candidate !== null) {
        errors.push(`[${id}] landslideRiskCandidate が無効 (10〜90 整数または null 必須): ${candidate}`);
      }
    } else {
      candidateVals.push(candidate);
    }

    const status = m["landslideDataStatus"];
    if (typeof status === "string" && VALID_LANDSLIDE_STATUSES.has(status)) {
      statusCounts[status] = (statusCounts[status] ?? 0) + 1;
      const source = m["landslideSource"];
      if (typeof source === "string" && source.trim() !== "") {
        sourceCount++;
      }
    } else if (status === "missing") {
      statusCounts.missing++;
    } else {
      errors.push(
        `[${id}] landslideDataStatus が無効 ` +
        `(scored|no-landslide-data|ward-averaged|missing 必須): ${status}`,
      );
    }
  }

  stats["landslide.scored件数"]           = statusCounts.scored;
  stats["landslide.no-landslide-data件数"] = statusCounts["no-landslide-data"];
  stats["landslide.ward-averaged件数"]     = statusCounts["ward-averaged"];
  stats["landslide.missing件数"]           = statusCounts.missing;
  stats["landslideSource件数"]             = sourceCount;

  if (candidateVals.length > 0) {
    stats["landslideRiskCandidate最小"] = Math.min(...candidateVals);
    stats["landslideRiskCandidate最大"] = Math.max(...candidateVals);
    stats["landslideRiskCandidate平均"] = Math.round(
      candidateVals.reduce((s, v) => s + v, 0) / candidateVals.length,
    );
  }

  return { errors, warnings, stats };
}

// -------------------------------------------------------
// tsunami-v1 フィールド検証（municipalities.json）
// -------------------------------------------------------

const VALID_TSUNAMI_STATUSES = new Set([
  "scored", "no-tsunami-data", "no-tsunami-risk", "ward-averaged", "missing",
]);

function validateTsunamiV1(
  data: Municipality[],
): { errors: string[]; warnings: string[]; stats: Record<string, number | string> } {
  const errors:   string[] = [];
  const warnings: string[] = [];
  const stats: Record<string, number | string> = {};

  const withTsunami = data.filter((m) => m["tsunamiRiskCandidate"] !== undefined);
  if (withTsunami.length === 0) {
    warnings.push(
      "tsunamiRiskCandidate フィールド未投入 (npm run import:tsunami を実行してください)",
    );
    return { errors, warnings, stats };
  }

  stats["tsunami投入件数"] = withTsunami.length;

  const statusCounts: Record<string, number> = {
    scored: 0, "no-tsunami-data": 0, "no-tsunami-risk": 0, "ward-averaged": 0, missing: 0,
  };
  const candidateVals: number[] = [];
  let sourceCount = 0;

  for (const m of data) {
    const id = String(m["jisCode"] ?? m["id"] ?? "unknown");
    const candidate = m["tsunamiRiskCandidate"];
    if (candidate === undefined) continue;

    if (
      typeof candidate !== "number" ||
      !Number.isInteger(candidate) ||
      candidate < 0 ||
      candidate > 100
    ) {
      if (candidate !== null) {
        errors.push(`[${id}] tsunamiRiskCandidate が無効 (0〜100 整数または null 必須): ${candidate}`);
      }
    } else {
      candidateVals.push(candidate);
    }

    const status = m["tsunamiDataStatus"];
    if (typeof status === "string" && VALID_TSUNAMI_STATUSES.has(status)) {
      statusCounts[status] = (statusCounts[status] ?? 0) + 1;
      const source = m["tsunamiSource"];
      if (typeof source === "string" && source.trim() !== "") {
        sourceCount++;
      }
    } else {
      errors.push(
        `[${id}] tsunamiDataStatus が無効 ` +
        `(scored|no-tsunami-data|no-tsunami-risk|ward-averaged|missing 必須): ${status}`,
      );
    }
  }

  stats["tsunami.scored件数"]          = statusCounts.scored;
  stats["tsunami.no-tsunami-data件数"] = statusCounts["no-tsunami-data"];
  stats["tsunami.no-tsunami-risk件数"] = statusCounts["no-tsunami-risk"];
  stats["tsunami.ward-averaged件数"]   = statusCounts["ward-averaged"];
  stats["tsunami.missing件数"]         = statusCounts.missing;
  stats["tsunamiSource件数"]           = sourceCount;

  if (candidateVals.length > 0) {
    stats["tsunamiRiskCandidate最小"] = Math.min(...candidateVals);
    stats["tsunamiRiskCandidate最大"] = Math.max(...candidateVals);
    stats["tsunamiRiskCandidate平均"] = Math.round(
      candidateVals.reduce((s, v) => s + v, 0) / candidateVals.length,
    );
  }

  return { errors, warnings, stats };
}

// -------------------------------------------------------
// overallScoreV2 検証（dry-run）
// -------------------------------------------------------

import { computeOverallScoreV2 } from "./scoring/score-overall-v2";

function validateOverallScoreV2(
  data: Municipality[],
): { errors: string[]; warnings: string[]; stats: Record<string, number | string> } {
  const errors:   string[] = [];
  const warnings: string[] = [];
  const stats: Record<string, number | string> = {};

  // overallScoreV2 フィールドが未投入の場合はスキップ
  const withV2 = data.filter((m) => m["overallScoreV2"] !== undefined);
  if (withV2.length === 0) {
    warnings.push(
      "overallScoreV2 フィールド未投入 (npm run score:overall-v2:write を実行してください)",
    );
    return { errors, warnings, stats };
  }

  // overallScore 不変確認: SCORE_FIELDS（earthquakeRisk 除外）での再計算と一致を事前確認済み
  // ここでは overallScoreV2 のスキーマ・再計算整合性を検証する

  stats["overallScoreV2件数"] = withV2.length;

  let mismatch    = 0;
  let nullCount   = 0;
  const v2Vals: number[] = [];

  for (const m of data) {
    const id      = String(m["jisCode"] ?? m["id"] ?? "unknown");
    const stored  = m["overallScoreV2"] as number | null | undefined;

    // null は許容（データ不足自治体）
    if (stored === null || stored === undefined) {
      nullCount++;
      continue;
    }

    // 数値 / 整数 / 10〜90 範囲
    if (
      typeof stored !== "number" ||
      !Number.isInteger(stored) ||
      stored < 10 || stored > 90
    ) {
      errors.push(`[${id}] overallScoreV2 が無効 (10〜90 整数または null 必須): ${stored}`);
      continue;
    }

    v2Vals.push(stored);

    // 再計算照合
    const { score: expected } = computeOverallScoreV2(m as Parameters<typeof computeOverallScoreV2>[0]);
    if (expected !== stored) {
      mismatch++;
      if (mismatch <= 5) {
        errors.push(
          `[${id}] overallScoreV2 再計算不一致: stored=${stored}, expected=${expected}`,
        );
      }
    }

    // overallScore が変更されていないことを確認
    // （計算式が異なるため overallScore と overallScoreV2 の値自体は異なりうる）
    const overallScore = m["overallScore"];
    if (typeof overallScore !== "number") {
      errors.push(`[${id}] overallScore が数値ではありません: ${overallScore}`);
    }
  }

  if (mismatch > 5) errors.push(`...overallScoreV2 再計算不一致 他 ${mismatch - 5}件`);

  stats["overallScoreV2-再計算不一致"] = mismatch;
  stats["overallScoreV2-null件数"]     = nullCount;

  if (v2Vals.length > 0) {
    stats["overallScoreV2最小"] = Math.min(...v2Vals);
    stats["overallScoreV2最大"] = Math.max(...v2Vals);
    stats["overallScoreV2平均"] = Math.round(
      v2Vals.reduce((a, b) => a + b, 0) / v2Vals.length,
    );
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

  // 8. jisCode 完全性チェック（常に error）
  let jisCodeCount = 0;
  for (const m of data) {
    const jis = m["jisCode"];
    if (typeof jis === "string" && JIS_RE.test(jis)) {
      jisCodeCount++;
    } else if (typeof jis === "string") {
      errors.push(`[${m.id}] jisCode の形式が不正 (5桁数字必須): "${jis}"`);
    } else {
      errors.push(`[${m.id}] jisCode 未設定 (必須フィールド)`);
    }
  }
  stats["jisCode設定済み"] = jisCodeCount;
  stats["jisCode未設定・不正"] = data.length - jisCodeCount;

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

  // 11b. jisCode 集合一致検証（municipalities vs search-index）
  if (fs.existsSync(searchIndexPath)) {
    try {
      const searchIndex = JSON.parse(fs.readFileSync(searchIndexPath, "utf-8")) as Array<{ jisCode?: string }>;
      const muniJisCodes = new Set(
        data.map((m) => m["jisCode"]).filter((c): c is string => typeof c === "string" && JIS_RE.test(c as string)),
      );
      const idxJisCodes = new Set(
        searchIndex.map((e) => e.jisCode).filter((c): c is string => typeof c === "string" && JIS_RE.test(c)),
      );
      const onlyInMuni = [...muniJisCodes].filter((c) => !idxJisCodes.has(c));
      const onlyInIdx  = [...idxJisCodes].filter((c) => !muniJisCodes.has(c));
      if (onlyInMuni.length > 0) {
        errors.push(
          `search-index に存在しない jisCode が municipalities.json にあります (${onlyInMuni.length}件): ` +
          onlyInMuni.slice(0, 10).join(", ") +
          (onlyInMuni.length > 10 ? " ..." : ""),
        );
      }
      if (onlyInIdx.length > 0) {
        errors.push(
          `municipalities.json に存在しない jisCode が search-index にあります (${onlyInIdx.length}件): ` +
          onlyInIdx.slice(0, 10).join(", ") +
          (onlyInIdx.length > 10 ? " ..." : ""),
        );
      }
    } catch {
      // parse 失敗は check #11 で報告済み
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

  // 14. shelter-sufficiency-v1 フィールド検証
  const v1Validation = validateShelterSufficiencyV1(data);
  errors.push(...v1Validation.errors);
  warnings.push(...v1Validation.warnings);
  Object.assign(stats, v1Validation.stats);

  // 15. aging-v1 フィールド検証
  const agingValidation = validateAgingV1(data);
  errors.push(...agingValidation.errors);
  warnings.push(...agingValidation.warnings);
  Object.assign(stats, agingValidation.stats);

  // 16. household-v1 フィールド検証
  const householdValidation = validateHouseholdV1(data);
  errors.push(...householdValidation.errors);
  warnings.push(...householdValidation.warnings);
  Object.assign(stats, householdValidation.stats);

  // 17. earthquake-v1 フィールド検証
  const earthquakeValidation = validateEarthquakeV1(data);
  errors.push(...earthquakeValidation.errors);
  warnings.push(...earthquakeValidation.warnings);
  Object.assign(stats, earthquakeValidation.stats);

  // 18. flood.json スキーマ検証（calculationVersion ゲート）
  const floodJsonValidation = validateFloodJson("data/processed/flood.json", strictMode);
  errors.push(...floodJsonValidation.errors);
  warnings.push(...floodJsonValidation.warnings);
  Object.assign(stats, floodJsonValidation.stats);

  // 18b. flood-v1 フィールド検証（municipalities.json）
  const floodValidation = validateFloodV1(data);
  errors.push(...floodValidation.errors);
  warnings.push(...floodValidation.warnings);
  Object.assign(stats, floodValidation.stats);

  // 20. landslide.json スキーマ検証（calculationVersion ゲート）
  const landslideJsonValidation = validateLandslideJson("data/processed/landslide.json");
  errors.push(...landslideJsonValidation.errors);
  warnings.push(...landslideJsonValidation.warnings);
  Object.assign(stats, landslideJsonValidation.stats);

  // 20b. landslide-v1 フィールド検証（municipalities.json）
  const landslideValidation = validateLandslideV1(data);
  errors.push(...landslideValidation.errors);
  warnings.push(...landslideValidation.warnings);
  Object.assign(stats, landslideValidation.stats);

  // 21. tsunami.json スキーマ検証（calculationVersion ゲート）
  const tsunamiJsonValidation = validateTsunamiJson("data/processed/tsunami.json");
  errors.push(...tsunamiJsonValidation.errors);
  warnings.push(...tsunamiJsonValidation.warnings);
  Object.assign(stats, tsunamiJsonValidation.stats);

  // 21b. tsunami-v1 フィールド検証（municipalities.json）
  const tsunamiValidation = validateTsunamiV1(data);
  errors.push(...tsunamiValidation.errors);
  warnings.push(...tsunamiValidation.warnings);
  Object.assign(stats, tsunamiValidation.stats);

  // 19. overallScoreV2 検証（dry-run）
  const v2Validation = validateOverallScoreV2(data);
  errors.push(...v2Validation.errors);
  warnings.push(...v2Validation.warnings);
  Object.assign(stats, v2Validation.stats);

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
