/**
 * 地震ハザードデータインポーター (earthquake-v1)
 *
 * データソース:
 *   防災科研 J-SHIS 条件付き超過確率 API (fltsearch)
 *   version=Y2020, period=P_T30, ijma=55, param=-1
 *
 * 入力: data/processed/earthquake.json
 *   形式: EarthquakeEntry[]（convert-jshis-earthquake-2020.ts の出力）
 *
 * 出力: data/processed/earthquake.json（バリデーション後 in-place 上書き）
 *   または --output PATH で別ファイルへ
 *
 * バリデーション:
 *   - jisCode 5桁数字
 *   - jisCode 重複なし
 *   - earthquakeDataStatus enum チェック
 *   - earthquakeRisk 10〜90 整数
 *   - direct / aggregated-from-wards: earthquakeProbability 0〜1
 *   - known-missing / not-found: earthquakeProbability null
 *   - earthquakePex >= 0 または null
 *   - earthquakeScore は number または null
 *   - earthquakeRank は正整数または null
 *   - earthquakeVersion === "Y2020"
 *   - overallScore には未反映（merge-datasets.ts 統合前）
 *
 * 使い方:
 *   npm run import:earthquake
 *   tsx scripts/importers/import-earthquake.ts [--input PATH] [--output PATH]
 */

import fs from "fs";
import path from "path";

// -------------------------------------------------------
// 定数
// -------------------------------------------------------

const DEFAULT_INPUT  = "data/processed/earthquake.json";
const DEFAULT_OUTPUT = "data/processed/earthquake.json"; // in-place

const JIS_RE = /^\d{5}$/;

const VALID_DATA_STATUSES = new Set([
  "direct",
  "aggregated-from-wards",
  "known-missing",
  "not-found",
]);

const SCORED_STATUSES   = new Set(["direct", "aggregated-from-wards"]);
const NULL_PROB_STATUSES = new Set(["known-missing", "not-found"]);

// -------------------------------------------------------
// 型定義
// -------------------------------------------------------

export interface EarthquakeEntry {
  jisCode:                     string;
  prefecture:                  string;
  name:                        string;
  earthquakeRisk:              number;
  earthquakeProbability:       number | null;
  earthquakePex:               number | null;
  earthquakeScore:             number | null;
  earthquakeRank:              number | null;
  earthquakeVersion:           "Y2020";
  earthquakeDataStatus:        string;
  earthquakeProbabilityMethod: string;
  earthquakeSourceJisCodes?:   string[];
  earthquakeProbabilityMin?:   number;
  earthquakeProbabilityMax?:   number;
  earthquakeWardCount?:        number;
  earthquakeSource:            string;
  earthquakeUpdatedAt:         string;
  calculationVersion:          string;
}

// -------------------------------------------------------
// ユーティリティ
// -------------------------------------------------------

function getArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// -------------------------------------------------------
// バリデーション・インポート
// -------------------------------------------------------

export function importEarthquake(inputPath: string): EarthquakeEntry[] {
  if (!fs.existsSync(inputPath)) {
    throw new Error(
      `入力ファイルが見つかりません: ${inputPath}\n` +
      `  npm run convert:jshis-earthquake-2020 を先に実行してください。`,
    );
  }

  const raw = JSON.parse(fs.readFileSync(inputPath, "utf-8")) as unknown[];

  if (!Array.isArray(raw)) {
    throw new Error(`入力ファイルの形式が不正です（配列を期待）: ${inputPath}`);
  }

  const errors: string[] = [];
  const results: EarthquakeEntry[] = [];
  const seenJisCodes = new Map<string, number>();

  for (let i = 0; i < raw.length; i++) {
    const row    = raw[i] as Record<string, unknown>;
    const rowNum = i + 1;
    let hasError = false;

    // ---- jisCode ----
    const jisCode = typeof row["jisCode"] === "string" ? row["jisCode"] : "";
    if (!JIS_RE.test(jisCode)) {
      errors.push(`[行${rowNum}] jisCode: 5桁数字必須 "${row["jisCode"]}"`);
      hasError = true;
    } else if (seenJisCodes.has(jisCode)) {
      errors.push(`[行${rowNum}] jisCode 重複: "${jisCode}" (初出: 行${seenJisCodes.get(jisCode)})`);
      hasError = true;
    } else {
      seenJisCodes.set(jisCode, rowNum);
    }

    // ---- earthquakeDataStatus ----
    const dataStatus = row["earthquakeDataStatus"];
    if (typeof dataStatus !== "string" || !VALID_DATA_STATUSES.has(dataStatus)) {
      errors.push(
        `[行${rowNum}][${jisCode}] earthquakeDataStatus: 不正な値 "${dataStatus}"` +
        ` (valid: ${[...VALID_DATA_STATUSES].join(" | ")})`,
      );
      hasError = true;
    }

    // ---- earthquakeRisk ----
    const risk = row["earthquakeRisk"];
    if (
      typeof risk !== "number" ||
      !Number.isInteger(risk) ||
      risk < 10 ||
      risk > 90
    ) {
      errors.push(`[行${rowNum}][${jisCode}] earthquakeRisk: 10〜90 整数必須 "${risk}"`);
      hasError = true;
    }

    // ---- earthquakeVersion ----
    if (row["earthquakeVersion"] !== "Y2020") {
      errors.push(
        `[行${rowNum}][${jisCode}] earthquakeVersion: "Y2020" 必須 "${row["earthquakeVersion"]}"`,
      );
      hasError = true;
    }

    // ---- earthquakeProbability ----
    const prob = row["earthquakeProbability"];
    if (!hasError && SCORED_STATUSES.has(dataStatus as string)) {
      if (typeof prob !== "number" || prob < 0 || prob > 1) {
        errors.push(
          `[行${rowNum}][${jisCode}] earthquakeProbability: ${dataStatus} では 0〜1 の数値必須 "${prob}"`,
        );
        hasError = true;
      }
    } else if (!hasError && NULL_PROB_STATUSES.has(dataStatus as string)) {
      if (prob !== null) {
        errors.push(
          `[行${rowNum}][${jisCode}] earthquakeProbability: ${dataStatus} では null 必須 "${prob}"`,
        );
        hasError = true;
      }
    }

    // ---- earthquakePex ----
    const pex = row["earthquakePex"];
    if (pex !== null && (typeof pex !== "number" || pex < 0)) {
      errors.push(
        `[行${rowNum}][${jisCode}] earthquakePex: 0以上の数値または null 必須 "${pex}"`,
      );
      hasError = true;
    }

    // ---- earthquakeScore ----
    const score = row["earthquakeScore"];
    if (score !== null && typeof score !== "number") {
      errors.push(
        `[行${rowNum}][${jisCode}] earthquakeScore: number または null 必須 "${score}"`,
      );
      hasError = true;
    }

    // ---- earthquakeRank ----
    const rank = row["earthquakeRank"];
    if (rank !== null) {
      if (typeof rank !== "number" || !Number.isInteger(rank) || rank < 1) {
        errors.push(
          `[行${rowNum}][${jisCode}] earthquakeRank: 正整数または null 必須 "${rank}"`,
        );
        hasError = true;
      }
    }

    // ---- direct: pex は null 不可 ----
    if (!hasError && dataStatus === "direct" && pex === null) {
      errors.push(
        `[行${rowNum}][${jisCode}] direct 行の earthquakePex が null（J-SHIS レスポンス要確認）`,
      );
      hasError = true;
    }

    if (!hasError) {
      results.push(row as unknown as EarthquakeEntry);
    }
  }

  if (errors.length > 0) {
    throw new Error(`バリデーションエラー (${errors.length}件):\n${errors.join("\n")}`);
  }

  return results;
}

// -------------------------------------------------------
// CLI エントリポイント
// -------------------------------------------------------

if (require.main === module) {
  const inputPath  = getArg("--input")  ?? DEFAULT_INPUT;
  const outputPath = getArg("--output") ?? DEFAULT_OUTPUT;

  try {
    const results = importEarthquake(inputPath);

    const byStatus = (s: string) => results.filter((e) => e.earthquakeDataStatus === s);
    const direct     = byStatus("direct");
    const aggregated = byStatus("aggregated-from-wards");
    const known      = byStatus("known-missing");
    const notFound   = byStatus("not-found");

    const risks  = results.map((e) => e.earthquakeRisk);
    const probs  = results.map((e) => e.earthquakeProbability).filter((v): v is number => v !== null);
    const pexArr = results.map((e) => e.earthquakePex).filter((v): v is number => v !== null);

    console.log(`\n--- import 結果 ---`);
    console.log(`total                   : ${results.length}`);
    console.log(`direct                  : ${direct.length}`);
    console.log(`aggregated-from-wards   : ${aggregated.length}`);
    console.log(`known-missing           : ${known.length}`);
    console.log(`not-found               : ${notFound.length}`);
    console.log(`\nearthquakeRisk range    : ${Math.min(...risks)} 〜 ${Math.max(...risks)}`);
    console.log(`earthquakeProbability   : ${probs.length ? Math.min(...probs).toFixed(5) : "—"} 〜 ${probs.length ? Math.max(...probs).toFixed(5) : "—"}`);
    console.log(`earthquakePex range     : ${pexArr.length ? Math.min(...pexArr).toLocaleString() : "—"} 〜 ${pexArr.length ? Math.max(...pexArr).toLocaleString() : "—"}`);
    console.log(`earthquakeVersion=Y2020 : 全件 ✅`);
    console.log(`overallScore反映        : なし（merge-datasets.ts 統合前）`);

    console.log(`\n先頭5件:`);
    results.slice(0, 5).forEach((e) =>
      console.log(
        `  ${e.jisCode} ${e.prefecture} ${e.name}` +
        ` | status=${e.earthquakeDataStatus}` +
        ` | prob=${e.earthquakeProbability?.toFixed(5) ?? "null"}` +
        ` | pex=${e.earthquakePex ?? "null"}` +
        ` | risk=${e.earthquakeRisk}`,
      ),
    );

    if (outputPath !== inputPath) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), "utf-8");
      const sizeKb = (fs.statSync(outputPath).size / 1024).toFixed(1);
      console.log(`\nOK: ${results.length}件 → ${outputPath} (${sizeKb} KB)`);
    } else {
      console.log(`\nOK: ${results.length}件 バリデーション完了`);
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
