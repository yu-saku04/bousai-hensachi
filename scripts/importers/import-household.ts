/**
 * 世帯構成データインポーター (household-v1)
 *
 * データソース:
 *   e-Stat 令和2年国勢調査 表9-1-1 (statsDataId: 0003445284)
 *   一般世帯総数 / 65歳以上単独世帯 / 夫65歳以上妻60歳以上夫婦のみ世帯
 *
 * 入力CSV: data/raw/national/household.csv
 *   カラム: jisCode,totalGeneralHouseholds,elderlySingleHouseholds,elderlyCoupleHouseholds
 *
 * 出力: data/processed/household.json
 *   形式: HouseholdEntry[]（calculationVersion: "household-v1"）
 *
 * 使い方:
 *   npm run import:household
 *   tsx scripts/importers/import-household.ts [--input PATH] [--output PATH] [--master PATH]
 */

import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";

const JIS_RE = /^\d{5}$/;

/** 既知欠損 jisCode（人口・高齢化データと同じ10件） */
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

export interface HouseholdEntry {
  jisCode: string;
  totalGeneralHouseholds: number;
  elderlySingleHouseholds: number;
  elderlyCoupleHouseholds: number;
  calculationVersion: "household-v1";
}

function getArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function importHouseholdCsv(
  inputPath: string,
  masterPath?: string,
): HouseholdEntry[] {
  if (!fs.existsSync(inputPath)) {
    throw new Error(
      `入力ファイルが見つかりません: ${inputPath}\n` +
      `  npm run convert:estat-household-2020 を先に実行してください。`,
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
  const results: HouseholdEntry[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row    = rows[i];
    const rowNum = i + 2;

    const jisCode              = (row["jisCode"]                ?? "").trim();
    const totalRaw             = (row["totalGeneralHouseholds"]  ?? "").trim();
    const singleRaw            = (row["elderlySingleHouseholds"] ?? "").trim();
    const coupleRaw            = (row["elderlyCoupleHouseholds"] ?? "").trim();

    let hasError = false;

    if (!JIS_RE.test(jisCode)) {
      errors.push(`[行${rowNum}] jisCode: 5桁数字必須 "${jisCode}"`);
      hasError = true;
    } else if (masterJisCodes && !masterJisCodes.has(jisCode)) {
      errors.push(`[行${rowNum}] jisCode: master に存在しないコード "${jisCode}"`);
      hasError = true;
    }

    const total  = Number(totalRaw);
    const single = Number(singleRaw);
    const couple = Number(coupleRaw);

    if (!totalRaw || isNaN(total) || !Number.isInteger(total) || total <= 0) {
      errors.push(`[行${rowNum}] totalGeneralHouseholds: 正整数必須 "${totalRaw}"`);
      hasError = true;
    }
    if (!singleRaw || isNaN(single) || !Number.isInteger(single) || single < 0) {
      errors.push(`[行${rowNum}] elderlySingleHouseholds: 0以上整数必須 "${singleRaw}"`);
      hasError = true;
    }
    if (!coupleRaw || isNaN(couple) || !Number.isInteger(couple) || couple < 0) {
      errors.push(`[行${rowNum}] elderlyCoupleHouseholds: 0以上整数必須 "${coupleRaw}"`);
      hasError = true;
    }

    // 整合性チェック（個別フィールドが valid な場合のみ）
    if (!hasError) {
      if (single > total) {
        errors.push(`[行${rowNum}] elderlySingleHouseholds(${single}) > totalGeneralHouseholds(${total})`);
        hasError = true;
      }
      if (couple > total) {
        errors.push(`[行${rowNum}] elderlyCoupleHouseholds(${couple}) > totalGeneralHouseholds(${total})`);
        hasError = true;
      }
    }

    if (!hasError) {
      results.push({
        jisCode,
        totalGeneralHouseholds:  total,
        elderlySingleHouseholds: single,
        elderlyCoupleHouseholds: couple,
        calculationVersion: "household-v1",
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
  const inputPath  = getArg("--input")  ?? "data/raw/national/household.csv";
  const outputPath = getArg("--output") ?? "data/processed/household.json";
  const masterPath = getArg("--master") ?? "data/master/municipalities-base.json";

  try {
    const results = importHouseholdCsv(inputPath, masterPath);

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
    const missingAll     = [...masterMap.keys()].filter((c) => !resultSet.has(c));
    const missingKnown   = missingAll.filter((c) => KNOWN_MISSING.has(c));
    const missingUnknown = missingAll.filter((c) => !KNOWN_MISSING.has(c));

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
