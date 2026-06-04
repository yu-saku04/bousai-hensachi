/**
 * e-Stat 令和2年国勢調査 表9-1-1 converter（世帯構成）
 *
 * 変換元: data/raw/estat/household-2020.csv   （fetch-estat-household-2020.ts の出力）
 * 変換先: data/raw/national/household.csv
 *
 * e-Stat 表情報:
 *   統計表ID (statsDataId): 0003445284
 *   表名: 世帯の家族類型，世帯員の年齢による世帯の種類別一般世帯数－全国，都道府県，市区町村
 *   公表日: 2021-11-30
 *
 * 抽出条件:
 *   cat02_code = "0"（総数 ← fetch 時に既にフィルタ済み）
 *   cat01_code = "0"   → totalGeneralHouseholds（一般世帯総数）
 *   cat01_code = "R7"  → elderlySingleHouseholds（65歳以上単独世帯）
 *   cat01_code = "R6"  → elderlyCoupleHouseholds（夫65歳以上妻60歳以上夫婦のみ世帯）
 *   area_code  → 5桁 jisCode → master に存在する市区町村のみ
 *
 * 使い方:
 *   npm run convert:estat-household-2020
 *   tsx scripts/converters/convert-estat-household-2020.ts [--input PATH] [--output PATH] [--master PATH]
 */

import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";

// -------------------------------------------------------
// 定数
// -------------------------------------------------------

const DEFAULT_INPUT  = "data/raw/estat/household-2020.csv";
const DEFAULT_OUTPUT = "data/raw/national/household.csv";
const DEFAULT_MASTER = "data/master/municipalities-base.json";

const SOURCE_URL = "https://www.e-stat.go.jp/stat-search/files?statdisp_id=0003445284";
const UPDATED_AT = "2021-11-30";

/** cat01 抽出コード */
const CAT01_TOTAL         = "0";   // 一般世帯総数
const CAT01_ELDERLY_SOLO  = "R7";  // 65歳以上単独世帯
const CAT01_ELDERLY_COUPLE = "R6"; // 夫65歳以上妻60歳以上夫婦のみ世帯

const REQUIRED_CAT01 = new Set([CAT01_TOTAL, CAT01_ELDERLY_SOLO, CAT01_ELDERLY_COUPLE]);

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

// -------------------------------------------------------
// 列名候補
// -------------------------------------------------------

const AREA_CODE_COLS = ["area_code", "AREA_CODE", "地域コード", "市区町村コード"];
const CAT01_COLS     = ["cat01_code", "CAT01_CODE"];
const CAT02_COLS     = ["cat02_code", "CAT02_CODE"];
const VALUE_COLS     = ["value", "VALUE", "数値"];

// -------------------------------------------------------
// 型定義
// -------------------------------------------------------

interface MunicipalityMaster {
  jisCode: string;
  prefecture: string;
  municipality: string;
}

interface HouseholdRow {
  jisCode: string;
  totalGeneralHouseholds: number;
  elderlySingleHouseholds: number;
  elderlyCoupleHouseholds: number;
}

// -------------------------------------------------------
// ユーティリティ
// -------------------------------------------------------

function getArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function pick(candidates: string[], headers: string[]): string | null {
  for (const c of candidates) {
    if (headers.includes(c)) return c;
  }
  return null;
}

function normalizeAreaCode(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/[^0-9]/.test(trimmed)) return "";
  const n = parseInt(trimmed, 10);
  if (isNaN(n)) return "";
  const padded = String(n).padStart(5, "0");
  return padded.length === 5 ? padded : "";
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

// -------------------------------------------------------
// CSV 読み込み（メタデータブロック対応）
// -------------------------------------------------------

function readEstatCsv(filePath: string): Array<Record<string, string>> {
  const content = fs.readFileSync(filePath, "utf-8");

  const rawRows = parse(content, {
    bom: true,
    columns: false,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  }) as string[][];

  if (rawRows.length === 0) throw new Error("CSV が空です");

  // ヘッダー行を探す（先頭50行以内）
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rawRows.length, 50); i++) {
    const cells = rawRows[i].map((h) => h.trim());
    const hasArea  = AREA_CODE_COLS.some((c) => cells.includes(c));
    const hasValue = VALUE_COLS.some((c) => cells.includes(c));
    if (hasArea && hasValue) {
      headerIdx = i;
      break;
    }
  }

  if (headerIdx < 0) {
    const preview = rawRows.slice(0, 5).map((r) => r.slice(0, 8).join(" | ")).join("\n  ");
    throw new Error(
      `ヘッダー行が見つかりません（先頭50行を検索）。\n  先頭5行:\n  ${preview}`,
    );
  }

  const headers = rawRows[headerIdx].map((h) => h.trim());
  console.log(`ヘッダー行: ${headerIdx + 1}行目`);
  console.log(`ヘッダー (全列): ${headers.join(", ")}`);

  const result: Array<Record<string, string>> = [];
  for (let i = headerIdx + 1; i < rawRows.length; i++) {
    const row = rawRows[i];
    if (row.every((c) => !c.trim())) continue;
    const record: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      record[headers[j]] = (row[j] ?? "").trim();
    }
    result.push(record);
  }

  return result;
}

// -------------------------------------------------------
// メイン変換ロジック
// -------------------------------------------------------

function convertEstatHousehold(
  inputPath: string,
  outputPath: string,
  masterPath: string,
): void {
  if (!fs.existsSync(inputPath)) {
    throw new Error(
      `入力 CSV が見つかりません: ${inputPath}\n` +
      `  npm run fetch:estat-household-2020 を先に実行してください。`,
    );
  }
  if (!fs.existsSync(masterPath)) {
    throw new Error(`master ファイルが見つかりません: ${masterPath}`);
  }

  // Master 読み込み
  const masterRaw = JSON.parse(fs.readFileSync(masterPath, "utf-8")) as MunicipalityMaster[];
  const masterMap = new Map<string, MunicipalityMaster>();
  for (const m of masterRaw) {
    if (typeof m.jisCode === "string" && m.jisCode) {
      masterMap.set(m.jisCode, m);
    }
  }
  console.log(`\nmaster: ${masterMap.size}件`);

  // CSV 読み込み
  const rows = readEstatCsv(inputPath);
  if (rows.length === 0) throw new Error("CSV にデータ行がありません");
  console.log(`データ行数（ヘッダー以降）: ${rows.length.toLocaleString()} 行\n`);

  const headers = Object.keys(rows[0]);

  // -------------------------------------------------------
  // 列検出
  // -------------------------------------------------------

  const areaCodeCol = pick(AREA_CODE_COLS, headers);
  const cat01Col    = pick(CAT01_COLS,     headers);
  const cat02Col    = pick(CAT02_COLS,     headers);
  const valueCol    = pick(VALUE_COLS,     headers);

  if (!areaCodeCol) throw new Error(`地域コード列が見つかりません。ヘッダー: [${headers.slice(0, 12).join(", ")}]`);
  if (!cat01Col)    throw new Error(`cat01_code 列が見つかりません。候補: ${CAT01_COLS.join(", ")}`);
  if (!cat02Col)    throw new Error(`cat02_code 列が見つかりません。候補: ${CAT02_COLS.join(", ")}`);
  if (!valueCol)    throw new Error(`value 列が見つかりません。候補: ${VALUE_COLS.join(", ")}`);

  console.log(`--- 列検出 ---`);
  console.log(`地域コード: "${areaCodeCol}"`);
  console.log(`cat01_code: "${cat01Col}"`);
  console.log(`cat02_code: "${cat02Col}"`);
  console.log(`value:      "${valueCol}"`);

  // -------------------------------------------------------
  // cat01 コード診断（全国行で確認）
  // -------------------------------------------------------

  const cat01LabelCol = headers[headers.indexOf(cat01Col) + 1] ?? null;
  const cat01Seen = new Map<string, string>(); // code → label
  for (const row of rows) {
    const code  = row[cat01Col]?.trim() ?? "";
    const label = cat01LabelCol ? (row[cat01LabelCol]?.trim() ?? "") : "";
    if (code && !cat01Seen.has(code)) cat01Seen.set(code, label);
  }

  console.log(`\n--- cat01 コード一覧（CSV 内に存在するもの）---`);
  for (const [code, label] of cat01Seen) {
    const marker = code === CAT01_TOTAL          ? " ← ★totalGeneralHouseholds" :
                   code === CAT01_ELDERLY_SOLO   ? " ← ★elderlySingleHouseholds" :
                   code === CAT01_ELDERLY_COUPLE ? " ← ★elderlyCoupleHouseholds" : "";
    console.log(`  ${code.padEnd(6)} ${label}${marker}`);
  }

  for (const code of [CAT01_TOTAL, CAT01_ELDERLY_SOLO, CAT01_ELDERLY_COUPLE]) {
    if (!cat01Seen.has(code)) {
      throw new Error(`必須 cat01_code "${code}" が CSV に存在しません`);
    }
  }

  // -------------------------------------------------------
  // ピボット変換ループ
  // jisCode → { "0": n, "R7": n, "R6": n }
  // -------------------------------------------------------

  // pivot[jisCode][cat01_code] = value
  const pivot = new Map<string, Map<string, number>>();
  const duplicateErrors: string[] = [];

  let skippedBadCode   = 0;
  let skippedNotMaster = 0;
  let skippedInvalid   = 0;
  let skippedOtherCat  = 0;

  for (const row of rows) {
    const cat01 = row[cat01Col]?.trim() ?? "";

    // 不要な cat01 はスキップ（fetch フィルタで R6/R7/0 のみのはずだが念のため）
    if (!REQUIRED_CAT01.has(cat01)) { skippedOtherCat++; continue; }

    // 地域コード正規化
    const jisCode = normalizeAreaCode(row[areaCodeCol]?.trim() ?? "");
    if (!jisCode) { skippedBadCode++; continue; }

    // master 照合
    if (!masterMap.has(jisCode)) { skippedNotMaster++; continue; }

    // 値検証
    const rawVal = (row[valueCol] ?? "").trim().replace(/,/g, "");
    if (!/^\d+$/.test(rawVal)) { skippedInvalid++; continue; }
    const val = parseInt(rawVal, 10);
    if (!Number.isSafeInteger(val) || val < 0) { skippedInvalid++; continue; }

    // ピボットに格納（重複チェック）
    if (!pivot.has(jisCode)) pivot.set(jisCode, new Map());
    const entry = pivot.get(jisCode)!;
    if (entry.has(cat01)) {
      duplicateErrors.push(`  jisCode=${jisCode} cat01=${cat01} 重複`);
    } else {
      entry.set(cat01, val);
    }
  }

  // -------------------------------------------------------
  // 重複エラー
  // -------------------------------------------------------

  if (duplicateErrors.length > 0) {
    console.error(`\n重複エラー (${duplicateErrors.length}件):`);
    for (const e of duplicateErrors.slice(0, 10)) console.error(e);
    throw new Error(`jisCode/cat01 重複が ${duplicateErrors.length}件あります`);
  }

  // -------------------------------------------------------
  // 3カテゴリ完全性チェック & バリデーション
  // -------------------------------------------------------

  const incompleteErrors: string[] = [];
  const validRows: HouseholdRow[] = [];

  for (const [jisCode, entry] of pivot) {
    const missing3 = [...REQUIRED_CAT01].filter((c) => !entry.has(c));
    if (missing3.length > 0) {
      incompleteErrors.push(`  jisCode=${jisCode} cat01欠損: ${missing3.join(", ")}`);
      continue;
    }

    const total  = entry.get(CAT01_TOTAL)!;
    const solo   = entry.get(CAT01_ELDERLY_SOLO)!;
    const couple = entry.get(CAT01_ELDERLY_COUPLE)!;

    if (total <= 0) {
      incompleteErrors.push(`  jisCode=${jisCode} totalGeneralHouseholds=${total} (正整数必須)`);
      continue;
    }
    if (solo > total) {
      incompleteErrors.push(`  jisCode=${jisCode} elderlySingleHouseholds(${solo}) > total(${total})`);
      continue;
    }
    if (couple > total) {
      incompleteErrors.push(`  jisCode=${jisCode} elderlyCoupleHouseholds(${couple}) > total(${total})`);
      continue;
    }

    validRows.push({
      jisCode,
      totalGeneralHouseholds:  total,
      elderlySingleHouseholds: solo,
      elderlyCoupleHouseholds: couple,
    });
  }

  if (incompleteErrors.length > 0) {
    console.error(`\n整合性エラー (${incompleteErrors.length}件):`);
    for (const e of incompleteErrors.slice(0, 10)) console.error(e);
    throw new Error(`整合性エラーが ${incompleteErrors.length}件あります`);
  }

  // -------------------------------------------------------
  // master との missing 分析
  // -------------------------------------------------------

  const matchedSet = new Set(validRows.map((r) => r.jisCode));
  const missingAll     = [...masterMap.keys()].filter((c) => !matchedSet.has(c));
  const missingKnown   = missingAll.filter((c) => KNOWN_MISSING.has(c));
  const missingUnknown = missingAll.filter((c) => !KNOWN_MISSING.has(c));

  console.log(`\n--- 変換結果 ---`);
  console.log(`matched      : ${validRows.length}件`);
  console.log(`duplicate    : 0件`);
  console.log(`missing      : ${missingAll.length}件`);
  console.log(`  既知欠損   : ${missingKnown.length}件`);
  for (const c of missingKnown) {
    const m = masterMap.get(c);
    console.log(`    ${c}  ${m?.prefecture ?? ""} ${m?.municipality ?? ""}`);
  }
  if (missingUnknown.length > 0) {
    console.error(`\n⚠️ 未知欠損 ${missingUnknown.length}件:`);
    for (const c of missingUnknown.slice(0, 20)) {
      const m = masterMap.get(c);
      console.error(`    ${c}  ${m?.prefecture ?? ""} ${m?.municipality ?? ""}`);
    }
    throw new Error(`未知欠損が ${missingUnknown.length}件あります`);
  } else {
    console.log(`  未知欠損   : 0件 ✅`);
  }

  console.log(`\nスキップ内訳:`);
  console.log(`  コード形式不正   : ${skippedBadCode}`);
  console.log(`  master不一致     : ${skippedNotMaster.toLocaleString()}`);
  console.log(`  無効値           : ${skippedInvalid}`);
  console.log(`  対象外cat01      : ${skippedOtherCat}`);

  // -------------------------------------------------------
  // CSV 出力（master 順＝jisCode 昇順）
  // -------------------------------------------------------

  const sortedRows = [...masterMap.keys()]
    .filter((c) => matchedSet.has(c))
    .map((c) => validRows.find((r) => r.jisCode === c)!);

  const outputLines = [
    "jisCode,totalGeneralHouseholds,elderlySingleHouseholds,elderlyCoupleHouseholds,sourceUrl,updatedAt",
    ...sortedRows.map((r) =>
      [
        csvEscape(r.jisCode),
        String(r.totalGeneralHouseholds),
        String(r.elderlySingleHouseholds),
        String(r.elderlyCoupleHouseholds),
        csvEscape(SOURCE_URL),
        csvEscape(UPDATED_AT),
      ].join(","),
    ),
  ];

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, outputLines.join("\n") + "\n", "utf-8");

  console.log(`\n出力: ${outputPath}`);
  console.log(`出力件数: ${sortedRows.length}件`);
  console.log(`sourceUrl: ${SOURCE_URL}`);
  console.log(`updatedAt: ${UPDATED_AT}`);

  // 先頭20行プレビュー
  console.log(`\n先頭20行プレビュー:`);
  outputLines.slice(0, 21).forEach((l, i) => console.log(`  [${String(i + 1).padStart(2)}] ${l}`));

  // サンプル値（先頭5件）
  console.log(`\n値サンプル（先頭5件）:`);
  sortedRows.slice(0, 5).forEach((r) => {
    const m = masterMap.get(r.jisCode);
    console.log(
      `  ${r.jisCode} ${(m?.prefecture ?? "").slice(0, 4)}${(m?.municipality ?? "").slice(0, 6)}` +
      `  total=${r.totalGeneralHouseholds.toLocaleString()}` +
      `  single=${r.elderlySingleHouseholds.toLocaleString()}` +
      `  couple=${r.elderlyCoupleHouseholds.toLocaleString()}`,
    );
  });

  console.log(`\n次のステップ:`);
  console.log(`  npm run import:household`);
}

// -------------------------------------------------------
// CLI
// -------------------------------------------------------

if (require.main === module) {
  const inputPath  = getArg("--input")  ?? DEFAULT_INPUT;
  const outputPath = getArg("--output") ?? DEFAULT_OUTPUT;
  const masterPath = getArg("--master") ?? DEFAULT_MASTER;

  try {
    convertEstatHousehold(inputPath, outputPath, masterPath);
  } catch (e) {
    console.error(`\nERROR: ${(e as Error).message}`);
    process.exit(1);
  }
}
