/**
 * 高齢者人口データインポーター (aging-v1)
 *
 * データソース:
 *   e-Stat 令和2年国勢調査 表2-7-1 (statsDataId: 0003445162)
 *   65歳以上人口（cat03=R3 再掲）
 *
 * 入力CSV: data/raw/national/aging.csv
 *   カラム: jisCode,elderlyPopulation,sourceUrl,updatedAt
 *
 * 出力: data/processed/aging.json
 *   形式: AgingEntry[]（calculationVersion: "aging-v1"）
 *
 * 使い方:
 *   npm run import:aging
 *   tsx scripts/importers/import-aging.ts [--input PATH] [--output PATH] [--master PATH]
 */

import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";

const JIS_RE  = /^\d{5}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 既知欠損 jisCode（人口データと同じ10件） */
const KNOWN_MISSING = new Set([
  "01695", // 色丹村（北方領土）
  "01696", // 泊村（北方領土）
  "01697", // 留夜別村（北方領土）
  "01698", // 留別村（北方領土）
  "01699", // 紗那村（北方領土）
  "01700", // 蘂取村（北方領土）
  "07546", // 双葉町（避難自治体）
  "22138", // 浜松市中央区（2024年新設区）
  "22139", // 浜松市浜名区（2024年新設区）
  "22140", // 浜松市天竜区（2024年新設区）
]);

function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, mo, d] = s.split("-").map(Number);
  const dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export interface AgingEntry {
  jisCode: string;
  elderlyPopulation: number;
  sourceUrl: string;
  updatedAt: string;
  calculationVersion: "aging-v1";
}

function getArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function importAgingCsv(
  inputPath: string,
  masterPath?: string,
): AgingEntry[] {
  if (!fs.existsSync(inputPath)) {
    throw new Error(
      `入力ファイルが見つかりません: ${inputPath}\n` +
      `  npm run convert:estat-aging-2020 を先に実行してください。`,
    );
  }

  let masterJisCodes: Set<string> | null = null;
  if (masterPath) {
    if (!fs.existsSync(masterPath)) {
      throw new Error(`master ファイルが見つかりません: ${masterPath}`);
    }
    const master = JSON.parse(
      fs.readFileSync(masterPath, "utf-8"),
    ) as Array<{ jisCode?: string }>;
    masterJisCodes = new Set(
      master.map((m) => m.jisCode).filter((c): c is string => typeof c === "string"),
    );
  }

  const content = fs.readFileSync(inputPath, "utf-8");
  const rows: Record<string, string>[] = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });

  const errors: string[] = [];
  const results: AgingEntry[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row    = rows[i];
    const rowNum = i + 2;

    const jisCode          = (row["jisCode"]          ?? "").trim();
    const elderlyPopRaw    = (row["elderlyPopulation"] ?? "").trim();
    const sourceUrl        = (row["sourceUrl"]         ?? "").trim();
    const updatedAt        = (row["updatedAt"]         ?? "").trim();

    let hasError = false;

    if (!JIS_RE.test(jisCode)) {
      errors.push(`[行${rowNum}] jisCode: 5桁数字必須 "${jisCode}"`);
      hasError = true;
    } else if (masterJisCodes && !masterJisCodes.has(jisCode)) {
      errors.push(`[行${rowNum}] jisCode: master に存在しないコード "${jisCode}"`);
      hasError = true;
    }

    const elderlyPop = Number(elderlyPopRaw);
    if (
      !elderlyPopRaw ||
      isNaN(elderlyPop) ||
      !Number.isInteger(elderlyPop) ||
      elderlyPop < 0
    ) {
      errors.push(`[行${rowNum}] elderlyPopulation: 0以上整数必須 "${elderlyPopRaw}"`);
      hasError = true;
    }

    if (!isHttpUrl(sourceUrl)) {
      errors.push(`[行${rowNum}] sourceUrl: http(s) URL 必須 "${sourceUrl}"`);
      hasError = true;
    }

    if (!isValidDate(updatedAt)) {
      errors.push(`[行${rowNum}] updatedAt: 実在する YYYY-MM-DD 必須 "${updatedAt}"`);
      hasError = true;
    }

    if (!hasError) {
      results.push({
        jisCode,
        elderlyPopulation: elderlyPop,
        sourceUrl,
        updatedAt,
        calculationVersion: "aging-v1",
      });
    }
  }

  // jisCode 重複検出
  const jisCodeRows = new Map<string, number[]>();
  for (let i = 0; i < rows.length; i++) {
    const jisCode = (rows[i]["jisCode"] ?? "").trim();
    if (!JIS_RE.test(jisCode)) continue;
    const existing = jisCodeRows.get(jisCode) ?? [];
    existing.push(i + 2);
    jisCodeRows.set(jisCode, existing);
  }
  for (const [jisCode, rowNums] of jisCodeRows) {
    if (rowNums.length > 1) {
      errors.push(`jisCode 重複: "${jisCode}" 行 ${rowNums.join(", ")}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`バリデーションエラー (${errors.length}件):\n${errors.join("\n")}`);
  }

  return results;
}

if (require.main === module) {
  const inputPath  = getArg("--input")  ?? "data/raw/national/aging.csv";
  const outputPath = getArg("--output") ?? "data/processed/aging.json";
  const masterPath = getArg("--master") ?? "src/data/municipalities.json";

  try {
    const results = importAgingCsv(inputPath, masterPath);

    // master との照合で missing / known-missing を分類
    const master = JSON.parse(
      fs.readFileSync(masterPath, "utf-8"),
    ) as Array<{ jisCode?: string; prefecture?: string; municipality?: string }>;
    const masterMap = new Map(
      master
        .filter((m): m is { jisCode: string; prefecture: string; municipality: string } =>
          typeof m.jisCode === "string",
        )
        .map((m) => [m.jisCode, m]),
    );
    const resultSet = new Set(results.map((r) => r.jisCode));
    const missingAll = [...masterMap.keys()].filter((c) => !resultSet.has(c));
    const missingKnown    = missingAll.filter((c) => KNOWN_MISSING.has(c));
    const missingUnknown  = missingAll.filter((c) => !KNOWN_MISSING.has(c));

    console.log(`\n--- import 結果 ---`);
    console.log(`matched      : ${results.length}件`);
    console.log(`duplicate    : 0件`);
    console.log(`missing      : ${missingAll.length}件`);
    console.log(`  既知欠損   : ${missingKnown.length}件`);
    for (const c of missingKnown) {
      const m = masterMap.get(c);
      console.log(`    ${c}  ${m?.prefecture ?? ""} ${m?.municipality ?? ""}`);
    }
    if (missingUnknown.length > 0) {
      console.warn(`  ⚠️ 未知欠損 : ${missingUnknown.length}件`);
      for (const c of missingUnknown.slice(0, 20)) {
        const m = masterMap.get(c);
        console.warn(`    ${c}  ${m?.prefecture ?? ""} ${m?.municipality ?? ""}`);
      }
    } else {
      console.log(`  未知欠損   : 0件 ✅`);
    }

    console.log(`\n先頭5件:`);
    results.slice(0, 5).forEach((r) =>
      console.log(`  ${JSON.stringify(r)}`),
    );

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), "utf-8");
    console.log(`\nOK: ${results.length}件 → ${outputPath}`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
