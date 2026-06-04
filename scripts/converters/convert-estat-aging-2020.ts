/**
 * e-Stat 令和2年国勢調査 表2-7-1 converter（65歳以上人口）
 *
 * 変換元: data/raw/estat/aging-2020.csv   （fetch-estat-aging-2020.ts の出力）
 * 変換先: data/raw/national/aging.csv
 *
 * e-Stat 表情報:
 *   統計表ID (statsDataId): 0003445162
 *   表名: 男女，年齢（5歳階級），国籍総数か日本人別人口－全国，都道府県，市区町村
 *   公表日: 2021-11-30
 *
 * 抽出条件:
 *   cat01_code = "0"   （国籍総数）
 *   cat02_code = "0"   （男女：総数）
 *   cat03_code = "R3"  （年齢再掲：65歳以上）
 *     ↑ R3 が存在しない場合のみ 14〜21（65〜69, …, 100歳以上）を合算
 *   area_code → 5桁ゼロ埋め jisCode → master に存在する市区町村のみ
 *
 * 使い方:
 *   npm run convert:estat-aging-2020
 *   tsx scripts/converters/convert-estat-aging-2020.ts [--input PATH] [--output PATH] [--master PATH]
 */

import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";

// -------------------------------------------------------
// 定数
// -------------------------------------------------------

const DEFAULT_INPUT  = "data/raw/estat/aging-2020.csv";
const DEFAULT_OUTPUT = "data/raw/national/aging.csv";
const DEFAULT_MASTER = "data/master/municipalities-base.json";

const SOURCE_URL = "https://www.e-stat.go.jp/stat-search/files?statdisp_id=0003445162";
const UPDATED_AT = "2021-11-30";

/** 抽出条件 */
const CAT01_TOTAL    = "0";    // 国籍総数
const CAT02_TOTAL    = "0";    // 男女：総数
const CAT03_ELDERLY_DIRECT = "R3"; // （再掲）65歳以上
/** R3 がない場合に合算する5歳階級コード: 65〜69, 70〜74, …, 100歳以上 */
const CAT03_ELDERLY_RANGES = new Set(["14","15","16","17","18","19","20","21"]);

// -------------------------------------------------------
// 列名候補（CSV 出力によって揺れるため複数候補）
// -------------------------------------------------------

const AREA_CODE_COLS = ["area_code", "AREA_CODE", "地域コード", "市区町村コード"];
const CAT01_COLS     = ["cat01_code", "CAT01_CODE", "国籍コード"];
const CAT02_COLS     = ["cat02_code", "CAT02_CODE", "性別コード", "男女コード"];
const CAT03_COLS     = ["cat03_code", "CAT03_CODE", "年齢コード"];
const VALUE_COLS     = ["value", "VALUE", "人口（人）", "人口(人)", "人口", "数値"];

// -------------------------------------------------------
// 型定義
// -------------------------------------------------------

interface MunicipalityMaster {
  jisCode: string;
  prefecture: string;
  municipality: string;
}

interface OutputRow {
  jisCode: string;
  elderlyPopulation: number;
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
  // 英字・記号混じり（旧市区町村コード等）は除外
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

/**
 * e-Stat 連結 CSV を読み込み、ヘッダー行以降のデータ行を返す。
 * ページ境界で挿入されるメタデータ行は地域コード列を持たないため、
 * 変換ループ内で自動スキップされる。
 */
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
    const preview = rawRows.slice(0, 5).map((r) => r.slice(0, 6).join(" | ")).join("\n  ");
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

function convertEstatAging(
  inputPath: string,
  outputPath: string,
  masterPath: string,
): void {
  if (!fs.existsSync(inputPath)) {
    throw new Error(
      `入力 CSV が見つかりません: ${inputPath}\n` +
      `  npm run fetch:estat-aging-2020 を先に実行してください。`,
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
  const cat03Col    = pick(CAT03_COLS,     headers);
  const valueCol    = pick(VALUE_COLS,     headers);

  if (!areaCodeCol) throw new Error(`地域コード列が見つかりません。ヘッダー: [${headers.slice(0, 10).join(", ")}]`);
  if (!cat01Col)    throw new Error(`国籍コード列が見つかりません。候補: ${CAT01_COLS.join(", ")}`);
  if (!cat02Col)    throw new Error(`性別コード列が見つかりません。候補: ${CAT02_COLS.join(", ")}`);
  if (!cat03Col)    throw new Error(`年齢コード列が見つかりません。候補: ${CAT03_COLS.join(", ")}`);
  if (!valueCol)    throw new Error(`人口値列が見つかりません。候補: ${VALUE_COLS.join(", ")}`);

  console.log(`--- 列検出 ---`);
  console.log(`地域コード: "${areaCodeCol}"`);
  console.log(`国籍コード: "${cat01Col}"`);
  console.log(`性別コード: "${cat02Col}"`);
  console.log(`年齢コード: "${cat03Col}"`);
  console.log(`人口値:     "${valueCol}"`);

  // -------------------------------------------------------
  // 年齢カテゴリコード診断（国籍総数・総数・全国行から一覧取得）
  // -------------------------------------------------------

  console.log(`\n--- 年齢カテゴリコード一覧（cat01=0, cat02=0, area=00000）---`);
  const ageCategoryMap = new Map<string, string>(); // code → label
  // cat03ラベル列を探す（cat03_code の隣の列）
  const cat03LabelCol = headers[headers.indexOf(cat03Col) + 1] ?? null;

  for (const row of rows) {
    if (
      row[cat01Col] !== CAT01_TOTAL ||
      row[cat02Col] !== CAT02_TOTAL ||
      row[areaCodeCol]?.trim() === "00000"
    ) {
      const code  = row[cat03Col]?.trim() ?? "";
      const label = cat03LabelCol ? (row[cat03LabelCol]?.trim() ?? "") : "";
      if (code && !ageCategoryMap.has(code)) {
        ageCategoryMap.set(code, label);
      }
    }
  }

  const sortedCodes = [...ageCategoryMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [code, label] of sortedCodes) {
    const marker = code === CAT03_ELDERLY_DIRECT ? " ← ★採用" :
                   CAT03_ELDERLY_RANGES.has(code) ? " ← 合算候補" : "";
    console.log(`  ${code.padEnd(4)} ${label}${marker}`);
  }

  const hasDirectElderly = ageCategoryMap.has(CAT03_ELDERLY_DIRECT);
  console.log(`\nR3（再掲：65歳以上）直接カテゴリ: ${hasDirectElderly ? "あり → 直接採用" : "なし → 65〜69〜100歳以上を合算"}`);

  // -------------------------------------------------------
  // 変換ループ
  // -------------------------------------------------------

  /** jisCode → elderlyPopulation の直接採用用 */
  const directMap = new Map<string, number>();
  /** jisCode → 5歳階級合算用 */
  const sumMap    = new Map<string, number>();

  let skippedCat01     = 0;
  let skippedCat02     = 0;
  let skippedCat03     = 0;
  let skippedBadCode   = 0;
  let skippedNotMaster = 0;
  let skippedInvalid   = 0;

  for (const row of rows) {
    // 国籍・性別フィルタ
    if (row[cat01Col]?.trim() !== CAT01_TOTAL) { skippedCat01++; continue; }
    if (row[cat02Col]?.trim() !== CAT02_TOTAL) { skippedCat02++; continue; }

    const cat03 = row[cat03Col]?.trim() ?? "";

    // 年齢フィルタ
    if (hasDirectElderly) {
      if (cat03 !== CAT03_ELDERLY_DIRECT) { skippedCat03++; continue; }
    } else {
      if (!CAT03_ELDERLY_RANGES.has(cat03)) { skippedCat03++; continue; }
    }

    // 地域コード正規化
    const jisCode = normalizeAreaCode(row[areaCodeCol]?.trim() ?? "");
    if (!jisCode) { skippedBadCode++; continue; }

    // master 照合（全国・都道府県・旧市町村・DID等を除外）
    if (!masterMap.has(jisCode)) { skippedNotMaster++; continue; }

    // 人口値検証
    const rawVal = (row[valueCol] ?? "").trim().replace(/,/g, "");
    const POP_RE = /^\d+$/;
    if (!POP_RE.test(rawVal)) { skippedInvalid++; continue; }
    const val = parseInt(rawVal, 10);
    if (!Number.isSafeInteger(val) || val < 0) { skippedInvalid++; continue; }

    if (hasDirectElderly) {
      directMap.set(jisCode, val);
    } else {
      sumMap.set(jisCode, (sumMap.get(jisCode) ?? 0) + val);
    }
  }

  const outputMap: Map<string, number> = hasDirectElderly ? directMap : sumMap;

  // -------------------------------------------------------
  // 重複チェック（直接採用時は1エントリなので重複は起きないが念のため）
  // -------------------------------------------------------

  const duplicateErrors: string[] = [];
  const seenJis = new Set<string>();
  for (const jisCode of outputMap.keys()) {
    if (seenJis.has(jisCode)) {
      duplicateErrors.push(`  jisCode重複: ${jisCode}`);
    }
    seenJis.add(jisCode);
  }

  // -------------------------------------------------------
  // 結果ログ
  // -------------------------------------------------------

  const matched = outputMap.size;
  const missing = masterMap.size - matched;

  console.log(`\n--- 変換結果 ---`);
  console.log(`matched      : ${matched}件 (master に一致)`);
  console.log(`skipped      : 国籍フィルタ=${skippedCat01.toLocaleString()}, 性別フィルタ=${skippedCat02.toLocaleString()}`);
  console.log(`             : 年齢フィルタ=${skippedCat03.toLocaleString()}, コード形式不正=${skippedBadCode}, 無効値=${skippedInvalid}`);
  console.log(`             : master不一致=${skippedNotMaster.toLocaleString()}`);
  console.log(`duplicate    : ${duplicateErrors.length}件`);
  console.log(`missing      : ${missing}件 (master にあるが aging データなし)`);

  if (duplicateErrors.length > 0) {
    console.error(`\njisCode 重複エラー:`);
    for (const e of duplicateErrors) console.error(e);
    throw new Error(`jisCode 重複が ${duplicateErrors.length}件あります`);
  }

  if (missing > 0) {
    const missingCodes = [...masterMap.keys()].filter((c) => !outputMap.has(c));
    console.warn(`\nmissing jisCode 一覧 (先頭30件):`);
    for (const code of missingCodes.slice(0, 30)) {
      const m = masterMap.get(code)!;
      console.warn(`  ${code}  ${m.prefecture} ${m.municipality}`);
    }
    if (missingCodes.length > 30) console.warn(`  ...ほか ${missingCodes.length - 30}件`);
    console.warn(
      `\n⚠️  WARNING: ${missing}件欠損（人口データ欠損 10件と一致する場合は許容）`,
    );
  }

  // -------------------------------------------------------
  // CSV 出力（master 順＝jisCode 昇順）
  // -------------------------------------------------------

  const outputRows: OutputRow[] = [...masterMap.keys()]
    .filter((c) => outputMap.has(c))
    .map((c) => ({ jisCode: c, elderlyPopulation: outputMap.get(c)! }));

  const outputLines = [
    "jisCode,elderlyPopulation,sourceUrl,updatedAt",
    ...outputRows.map((r) =>
      [
        csvEscape(r.jisCode),
        String(r.elderlyPopulation),
        csvEscape(SOURCE_URL),
        csvEscape(UPDATED_AT),
      ].join(","),
    ),
  ];

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, outputLines.join("\n") + "\n", "utf-8");

  console.log(`\n出力: ${outputPath}`);
  console.log(`出力件数: ${outputRows.length}件`);
  console.log(`カテゴリ: ${hasDirectElderly ? `R3（再掲：65歳以上）直接採用` : `5歳階級合算`}`);
  console.log(`sourceUrl: ${SOURCE_URL}`);
  console.log(`updatedAt: ${UPDATED_AT}`);

  // 先頭20行プレビュー
  console.log(`\n先頭20行プレビュー:`);
  outputLines.slice(0, 21).forEach((l, i) => console.log(`  [${String(i + 1).padStart(2)}] ${l}`));

  console.log(`\n次のステップ:`);
  console.log(`  npm run import:aging`);
}

// -------------------------------------------------------
// CLI
// -------------------------------------------------------

if (require.main === module) {
  const inputPath  = getArg("--input")  ?? DEFAULT_INPUT;
  const outputPath = getArg("--output") ?? DEFAULT_OUTPUT;
  const masterPath = getArg("--master") ?? DEFAULT_MASTER;

  try {
    convertEstatAging(inputPath, outputPath, masterPath);
  } catch (e) {
    console.error(`\nERROR: ${(e as Error).message}`);
    process.exit(1);
  }
}
