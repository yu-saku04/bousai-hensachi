/**
 * e-Stat 令和2年国勢調査 人口等基本集計 表1-1-1 converter
 *
 * 変換元: data/raw/estat/population-2020.csv
 * 変換先: data/raw/national/population.csv
 *
 * e-Stat 表情報:
 *   統計表ID (statdisp_id): 0003445078
 *   統計名: 令和２年国勢調査 人口等基本集計
 *   表番号・表名: 表1-1-1 男女別人口－全国，都道府県，市区町村
 *   公表日: 2021-11-30
 *   取得先: https://www.e-stat.go.jp/stat-search/files?statdisp_id=0003445078
 *
 * フォーマット対応:
 *   - 長形式 (DB download): 地域コード + 男女列 + 表章事項列 + 値列
 *     → 男女=総数 かつ 表章事項=人口 の行のみ採用
 *   - 幅形式 (table download): 地域コード + 総数/男/女 の列
 *     → 総数列を採用
 *
 * フィルタリング:
 *   - 全国行 (00000)、都道府県行 (XX000)、master不一致行は除外
 *   - 旧市町村・人口集中地区等はmaster照合で自動除外
 *   - jisCode 重複は error
 *   - coverage が master件数と一致しなければ error
 *
 * 使い方:
 *   npm run convert:estat-population-2020
 *   tsx scripts/converters/convert-estat-population-2020.ts [--input PATH] [--output PATH] [--master PATH]
 */

import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";

// -------------------------------------------------------
// 定数
// -------------------------------------------------------

const DEFAULT_INPUT  = "data/raw/estat/population-2020.csv";
const DEFAULT_OUTPUT = "data/raw/national/population.csv";
const DEFAULT_MASTER = "data/master/municipalities-base.json";

const SOURCE_URL = "https://www.e-stat.go.jp/stat-search/files?statdisp_id=0003445078";
const UPDATED_AT = "2021-11-30";

const OUTPUT_COLUMNS = [
  "jisCode", "prefecture", "municipality", "population", "sourceUrl", "updatedAt",
] as const;

// -------------------------------------------------------
// e-Stat 列名候補（CSV 出力によってゆれるため複数候補を用意）
// -------------------------------------------------------

/** 地域コード列の候補 */
const AREA_CODE_COLS = [
  "地域コード", "area_code", "AREA_CODE", "コード", "地域code",
  "市区町村コード", "地域コード（数値）",
];
/** 男女別列の候補（長形式のみ） */
const SEX_COLS  = ["男女", "男女別", "cat01", "CAT01", "sex", "性別"];
/** 表章事項列の候補（長形式のみ） */
const ITEM_COLS = ["表章事項", "cat02", "CAT02", "表章", "item", "項目"];
/** 人口値列の候補 */
const VALUE_COLS = [
  "人口（人）", "人口(人)", "人口", "VALUE", "value",
  "数値", "人口数", "人口（総数）", "総数", "人口総数",
];

/** 男女=総数 と判断する値 */
const SEX_TOTAL_VALUES = new Set(["総数", "total", "T", "000", "001", "0"]);
/** 表章事項=人口 と判断する値 */
const ITEM_POP_VALUES  = new Set(["人口", "population", "P", "001", "T100000000"]);
/** 時間軸列の候補（2000年境界行を除外するために使用） */
const TIME_COLS = ["時間軸（年次）", "time_code", "TIME_CODE", "時間軸", "年次"];
/** 2020年として認識する値 */
const TIME_2020_VALUES = new Set(["2020年", "2020000000", "2020"]);

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
  prefecture: string;
  municipality: string;
  population: number;
  sourceUrl: string;
  updatedAt: string;
}

// -------------------------------------------------------
// ユーティリティ
// -------------------------------------------------------

function getArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * e-Stat の地域コードを5桁ゼロ埋めの JIS コードに正規化する。
 * 例: "1100" → "01100", "01100" → "01100"
 */
function normalizeAreaCode(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  // 英字サフィックス付きコード（例: "1220B", "0120C"）は旧2000年境界参照コードのため除外
  if (/[^0-9]/.test(trimmed)) return "";
  const n = parseInt(trimmed, 10);
  if (isNaN(n)) return "";
  const padded = String(n).padStart(5, "0");
  // 5桁超 (人口集中地区コード等) は除外
  return padded.length === 5 ? padded : "";
}

function pick(candidates: string[], headers: string[]): string | null {
  for (const c of candidates) {
    if (headers.includes(c)) return c;
  }
  return null;
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

// -------------------------------------------------------
// CSV 読み込み（メタデータ行対応）
// -------------------------------------------------------

/**
 * e-Stat CSV を読み込む。
 * ファイル先頭にメタデータ行が存在する場合も、
 * 「AREA_CODE_COLS の候補」と「VALUE_COLS の候補」を同時に含む行を
 * ヘッダー行として判定する。見つからない場合は error（フォールバックなし）。
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

  if (rawRows.length === 0) throw new Error("CSVが空です");

  // ヘッダー行を探す：AREA_CODE_COLS と VALUE_COLS を同時に含む行（先頭50行以内）
  // e-Stat API形式はメタデータブロック（RESULT/TABLE_INF等）が先頭30行前後に続くため50行まで探索する
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rawRows.length, 50); i++) {
    const cells = rawRows[i].map((h) => h.trim());
    const hasAreaCode = AREA_CODE_COLS.some((c) => cells.includes(c));
    const hasValueCol = VALUE_COLS.some((c) => cells.includes(c));
    if (hasAreaCode && hasValueCol) {
      headerIdx = i;
      break;
    }
  }

  if (headerIdx < 0) {
    const preview = rawRows.slice(0, 5).map((r) => r.slice(0, 6).join(" | ")).join("\n  ");
    throw new Error(
      `地域コード列と人口値列を同時に含むヘッダー行が見つかりません（先頭50行を検索）。\n` +
      `  地域コード候補: ${AREA_CODE_COLS.join(", ")}\n` +
      `  人口値候補:     ${VALUE_COLS.join(", ")}\n` +
      `  先頭5行プレビュー:\n  ${preview}`,
    );
  }

  const headers = rawRows[headerIdx].map((h) => h.trim());
  console.log(`ヘッダー行: ${headerIdx + 1}行目`);
  console.log(`ヘッダー (先頭10列): ${headers.slice(0, 10).join(", ")}`);

  const result: Array<Record<string, string>> = [];
  for (let i = headerIdx + 1; i < rawRows.length; i++) {
    const row = rawRows[i];
    if (row.every((cell) => !cell.trim())) continue; // 空行スキップ
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

function convertEstatPopulation(
  inputPath: string,
  outputPath: string,
  masterPath: string,
  allowMissing: boolean = false,
): void {
  // 入力ファイル確認
  if (!fs.existsSync(inputPath)) {
    throw new Error(
      `入力CSVが見つかりません: ${inputPath}\n\n` +
      `【取得手順】\n` +
      `  1. https://www.e-stat.go.jp/stat-search/files?statdisp_id=0003445078 にアクセス\n` +
      `  2. 「令和２年国勢調査 人口等基本集計」表1-1-1 の CSV をダウンロード\n` +
      `  3. ダウンロードしたファイルを UTF-8 で保存し、以下に配置:\n` +
      `     ${inputPath}\n` +
      `  4. 再度このコマンドを実行: npm run convert:estat-population-2020`,
    );
  }
  if (!fs.existsSync(masterPath)) {
    throw new Error(`masterファイルが見つかりません: ${masterPath}`);
  }

  // Master 読み込み
  const masterRaw = JSON.parse(
    fs.readFileSync(masterPath, "utf-8"),
  ) as MunicipalityMaster[];
  const masterMap = new Map<string, MunicipalityMaster>();
  for (const m of masterRaw) {
    if (typeof m.jisCode === "string" && m.jisCode) {
      masterMap.set(m.jisCode, m);
    }
  }
  console.log(`\nmaster: ${masterMap.size}件`);

  // CSV 読み込み
  const rows = readEstatCsv(inputPath);
  if (rows.length === 0) throw new Error("CSVにデータ行がありません");
  console.log(`データ行数: ${rows.length}行`);

  const headers = Object.keys(rows[0]);

  // -------------------------------------------------------
  // 列検出
  // -------------------------------------------------------

  const areaCodeCol = pick(AREA_CODE_COLS, headers);
  if (!areaCodeCol) {
    throw new Error(
      `地域コード列が見つかりません。\n` +
      `  CSVのヘッダー: [${headers.slice(0, 15).join(", ")}]\n` +
      `  期待する列名候補: ${AREA_CODE_COLS.join(", ")}`,
    );
  }

  const sexCol  = pick(SEX_COLS,  headers);
  const itemCol = pick(ITEM_COLS, headers);
  const timeCol = pick(TIME_COLS, headers);
  const isLongFormat = sexCol !== null;

  const valueCol = pick(VALUE_COLS, headers);
  if (!valueCol) {
    throw new Error(
      `人口値列が見つかりません。\n` +
      `  CSVのヘッダー: [${headers.slice(0, 15).join(", ")}]\n` +
      `  期待する列名候補: ${VALUE_COLS.join(", ")}`,
    );
  }

  console.log(`\n--- 列検出 ---`);
  console.log(`地域コード列: "${areaCodeCol}"`);
  console.log(`人口値列:     "${valueCol}"`);
  console.log(`時間軸列:     "${timeCol ?? "なし（全行採用）"}"`);
  console.log(
    `フォーマット: ${isLongFormat
      ? `長形式 (男女列="${sexCol}"${itemCol ? ` 表章列="${itemCol}"` : " 表章列=なし"})`
      : "幅形式 (人口列直接)"}`,
  );

  // -------------------------------------------------------
  // 変換ループ
  // -------------------------------------------------------

  const outputMap = new Map<string, OutputRow>();
  let skippedNotInMaster = 0;
  const skippedNotInMasterExamples: Array<{ jisCode: string; rawCode: string }> = [];
  let skippedBadCode     = 0;
  let skippedSex         = 0;
  let skippedItem        = 0;
  let skippedTime        = 0;
  let skippedInvalidPop  = 0;
  const duplicateErrors: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row    = rows[i];
    const rawCode = row[areaCodeCol] ?? "";
    const jisCode = normalizeAreaCode(rawCode);

    if (!jisCode) {
      skippedBadCode++;
      continue;
    }

    // 長形式: 男女=総数 のみ採用
    if (isLongFormat && sexCol) {
      const sexVal = (row[sexCol] ?? "").trim();
      if (!SEX_TOTAL_VALUES.has(sexVal)) {
        skippedSex++;
        continue;
      }
    }

    // 長形式: 表章事項=人口 のみ採用（列がある場合）
    if (isLongFormat && itemCol) {
      const itemVal = (row[itemCol] ?? "").trim();
      if (!ITEM_POP_VALUES.has(itemVal)) {
        skippedItem++;
        continue;
      }
    }

    // 時間軸=2020年 のみ採用（2000年境界行・旧市町村行を除外）
    if (timeCol) {
      const timeVal = (row[timeCol] ?? "").trim();
      if (!TIME_2020_VALUES.has(timeVal)) {
        skippedTime++;
        continue;
      }
    }

    // master 照合（全国・都道府県・旧市町村・人口集中地区等は自動除外）
    const masterEntry = masterMap.get(jisCode);
    if (!masterEntry) {
      skippedNotInMaster++;
      if (skippedNotInMasterExamples.length < 10) {
        skippedNotInMasterExamples.push({ jisCode, rawCode });
      }
      continue;
    }

    // 人口値の検証（正の整数のみ許可・silent truncate なし）
    const rawPop     = (row[valueCol] ?? "").trim();
    const normalized = rawPop.replace(/,/g, "").trim();
    const POS_INT_RE = /^[1-9]\d*$/;
    if (!POS_INT_RE.test(normalized)) {
      skippedInvalidPop++;
      console.warn(
        `  [行${i + 2}] jisCode=${jisCode} (${masterEntry.prefecture} ${masterEntry.municipality})` +
        ` 人口値が無効: "${rawPop}" (正の整数必須、小数・単位付き・注記付きは除外) → スキップ`,
      );
      continue;
    }
    const population = Number(normalized);
    if (!Number.isSafeInteger(population)) {
      skippedInvalidPop++;
      console.warn(
        `  [行${i + 2}] jisCode=${jisCode} 人口値が安全整数範囲外: ${population} → スキップ`,
      );
      continue;
    }

    // jisCode 重複検出
    if (outputMap.has(jisCode)) {
      duplicateErrors.push(
        `  [行${i + 2}] jisCode重複: ${jisCode} (${masterEntry.prefecture} ${masterEntry.municipality})`,
      );
      continue;
    }

    // prefecture / municipality は master 値を使用（CSV側の表記ゆれを吸収）
    outputMap.set(jisCode, {
      jisCode,
      prefecture:   masterEntry.prefecture,
      municipality: masterEntry.municipality,
      population,
      sourceUrl:    SOURCE_URL,
      updatedAt:    UPDATED_AT,
    });
  }

  // -------------------------------------------------------
  // 結果ログ
  // -------------------------------------------------------

  const matched = outputMap.size;
  const missing = masterMap.size - matched;

  console.log(`\n--- 変換結果 ---`);
  console.log(`matched      : ${matched}件 (masterに一致)`);
  console.log(`skipped      : master不一致=${skippedNotInMaster}, コード形式不正=${skippedBadCode}`);
  if (skippedNotInMasterExamples.length > 0) {
    console.log(`  master不一致 例 (先頭${skippedNotInMasterExamples.length}件):`);
    for (const ex of skippedNotInMasterExamples) {
      console.log(`    jisCode=${ex.jisCode} (元コード="${ex.rawCode}") 理由: master未存在`);
    }
  }
  if (isLongFormat) {
    console.log(`             : 男女フィルタ=${skippedSex}, 表章事項フィルタ=${skippedItem}`);
  }
  if (skippedTime > 0) {
    console.log(`             : 時間軸フィルタ(非2020年)=${skippedTime}`);
  }
  console.log(`             : 人口値無効=${skippedInvalidPop}`);
  console.log(`duplicate    : ${duplicateErrors.length}件`);
  console.log(`missing      : ${missing}件 (masterにあるが人口データなし)`);

  // 重複エラー
  if (duplicateErrors.length > 0) {
    console.error(`\njisCode 重複エラー:`);
    for (const e of duplicateErrors) console.error(e);
    throw new Error(`jisCode重複が ${duplicateErrors.length}件あります。CSVを確認してください`);
  }

  // Coverage チェック
  if (missing > 0) {
    const missingCodes = [...masterMap.keys()].filter((c) => !outputMap.has(c));
    const logFn = allowMissing ? console.warn : console.error;
    logFn(`\nmissing jisCode 一覧 (先頭30件):`);
    for (const code of missingCodes.slice(0, 30)) {
      const m = masterMap.get(code)!;
      logFn(`  ${code}  ${m.prefecture} ${m.municipality}`);
    }
    if (missingCodes.length > 30) {
      logFn(`  ...ほか ${missingCodes.length - 30}件`);
    }
    if (allowMissing) {
      console.warn(
        `\n⚠️  WARNING: coverage不足 ${matched}件 / master ${masterMap.size}件 (${missing}件欠損)` +
        ` — --allow-missing により続行します。` +
        `\n   ※ 北方領土・避難自治体・2020年以降新設区は欠損が想定されます。`,
      );
    } else {
      throw new Error(
        `coverage不足: ${matched}件 / master ${masterMap.size}件 (${missing}件欠損)\n` +
        `全国master全件の人口データが揃っている必要があります。\n` +
        `e-Stat CSV が全市区町村を含んでいるか確認してください。\n` +
        `北方領土・避難自治体・2020年以降新設区などは欠損が想定されます。その場合は:\n` +
        `  npm run convert:estat-population-2020 -- --allow-missing`,
      );
    }
  }

  // -------------------------------------------------------
  // CSV 出力（master順 = jisCode 昇順で安定）
  // -------------------------------------------------------

  const outputRows = [...masterMap.keys()]
    .filter((c) => outputMap.has(c))
    .map((c) => outputMap.get(c)!);

  const outputLines = [
    OUTPUT_COLUMNS.join(","),
    ...outputRows.map((row) =>
      OUTPUT_COLUMNS.map((col) => csvEscape(String(row[col]))).join(","),
    ),
  ];

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, outputLines.join("\n") + "\n", "utf-8");

  console.log(`\n出力: ${outputPath}`);
  console.log(`出力件数: ${outputRows.length}件`);
  console.log(`sourceUrl: ${SOURCE_URL}`);
  console.log(`updatedAt: ${UPDATED_AT}`);
  console.log(`\n次のステップ:`);
  console.log(`  npm run import:population`);
  console.log(`  npm run merge:data:strict`);
  console.log(`  npm run validate:data -- --strict`);
  console.log(`  npm run lint`);
  console.log(`  npx tsc --noEmit`);
  console.log(`  npm run build`);
}

// -------------------------------------------------------
// CLI
// -------------------------------------------------------

if (require.main === module) {
  const inputPath   = getArg("--input")  ?? DEFAULT_INPUT;
  const outputPath  = getArg("--output") ?? DEFAULT_OUTPUT;
  const masterPath  = getArg("--master") ?? DEFAULT_MASTER;
  const allowMissing = process.argv.includes("--allow-missing");

  try {
    convertEstatPopulation(inputPath, outputPath, masterPath, allowMissing);
  } catch (e) {
    console.error(`\nERROR: ${(e as Error).message}`);
    process.exit(1);
  }
}
