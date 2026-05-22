/**
 * CSV→JSON変換スクリプト（RFC4180準拠 / fail-fast バリデーション）
 *
 * 使い方:
 *   npm run convert:data
 *
 * 必須CSVカラム:
 *   id, prefecture, municipality, overallScore, floodRisk,
 *   earthquakeRisk, fireRisk, agingRisk, shelterCapacity, comment, actionTips, sourceNote
 *
 * Phase3 任意カラム（0〜100 の数値）:
 *   isolationRisk, childcareStressRisk, emotionalRecoveryRisk,
 *   socialSupportScore, infrastructureRecoveryScore, familyDisasterPreparedness
 *
 * 推奨: id は自治体コード（JISコード）を使用すること
 *   例: "130011" (東京都特別区部) ではなく "13113" (世田谷区)
 *   ref: https://www.soumu.go.jp/denshijiti/code.html
 *
 * actionTips: 「|」区切りで複数記述
 */

import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";

const CSV_INPUT_PATH          = path.join(__dirname, "../data/municipalities.csv");
const JSON_OUTPUT_PATH        = path.join(__dirname, "../src/data/municipalities.json");
const SEARCH_INDEX_OUTPUT_PATH = path.join(__dirname, "../src/data/municipality-search-index.json");

// -------------------------------------------------------
// 型定義（src/types/municipality.ts と同期させること）
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
  comment: string;
  actionTips: string[];
  sourceNote: string;
  postalCode?: string;
  latitude?: number;
  longitude?: number;
  population?: number;
  agingRate?: number;
  floodSource?: string;
  earthquakeSource?: string;
  fireSource?: string;
  shelterSource?: string;
  dataUpdatedAt?: string;
  // Phase3フィールド
  isolationRisk?: number;
  childcareStressRisk?: number;
  emotionalRecoveryRisk?: number;
  socialSupportScore?: number;
  infrastructureRecoveryScore?: number;
  familyDisasterPreparedness?: number;
}

interface SearchIndexItem {
  id: string;
  prefecture: string;
  municipality: string;
  overallScore: number;
}

// -------------------------------------------------------
// バリデーション設定
// -------------------------------------------------------

const REQUIRED_COLUMNS = [
  "id", "prefecture", "municipality",
  "overallScore", "floodRisk", "earthquakeRisk",
  "fireRisk", "agingRisk", "shelterCapacity",
  "comment", "actionTips", "sourceNote",
];

const POSTAL_CODE_RE = /^\d{3}-\d{4}$/;

// -------------------------------------------------------
// パーサー（fail-fast）
// -------------------------------------------------------

class RowError extends Error {
  constructor(rowNum: number, field: string, detail: string) {
    super(`[行${rowNum}] ${field}: ${detail}`);
  }
}

function requireString(row: Record<string, string>, key: string, rowNum: number): string {
  const v = (row[key] ?? "").trim();
  if (!v) throw new RowError(rowNum, key, "必須フィールドが空です");
  return v;
}

function parseScore(row: Record<string, string>, key: string, rowNum: number): number {
  const raw = (row[key] ?? "").trim();
  if (!raw) throw new RowError(rowNum, key, "スコアが空です");
  const n = Number(raw);
  if (isNaN(n)) throw new RowError(rowNum, key, `"${raw}" は数値ではありません`);
  if (n < 0 || n > 100) throw new RowError(rowNum, key, `${n} は 0〜100 の範囲外です`);
  return Math.round(n);
}

function parseOptionalNumber(
  row: Record<string, string>,
  key: string,
  rowNum: number,
  opts?: { min?: number; max?: number }
): number | undefined {
  const raw = (row[key] ?? "").trim();
  if (!raw) return undefined;
  const n = Number(raw);
  if (isNaN(n)) throw new RowError(rowNum, key, `"${raw}" は数値ではありません`);
  if (opts?.min !== undefined && n < opts.min)
    throw new RowError(rowNum, key, `${n} は最小値 ${opts.min} を下回ります`);
  if (opts?.max !== undefined && n > opts.max)
    throw new RowError(rowNum, key, `${n} は最大値 ${opts.max} を超えます`);
  return n;
}

function parseOptionalString(row: Record<string, string>, key: string): string | undefined {
  const v = (row[key] ?? "").trim();
  return v || undefined;
}

function parsePostalCode(row: Record<string, string>, rowNum: number): string | undefined {
  const raw = parseOptionalString(row, "postalCode");
  if (!raw) return undefined;
  if (!POSTAL_CODE_RE.test(raw))
    throw new RowError(rowNum, "postalCode", `"${raw}" は XXX-XXXX 形式ではありません`);
  return raw;
}

function parseActionTips(row: Record<string, string>): string[] {
  return (row["actionTips"] ?? "")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
}

// -------------------------------------------------------
// 行 → Municipality 変換
// -------------------------------------------------------

function rowToMunicipality(row: Record<string, string>, rowNum: number): Municipality {
  const id           = requireString(row, "id", rowNum);
  const prefecture   = requireString(row, "prefecture", rowNum);
  const municipality = requireString(row, "municipality", rowNum);
  const comment      = requireString(row, "comment", rowNum);
  const sourceNote   = requireString(row, "sourceNote", rowNum);

  return {
    id,
    prefecture,
    municipality,
    overallScore:    parseScore(row, "overallScore",    rowNum),
    floodRisk:       parseScore(row, "floodRisk",       rowNum),
    earthquakeRisk:  parseScore(row, "earthquakeRisk",  rowNum),
    fireRisk:        parseScore(row, "fireRisk",        rowNum),
    agingRisk:       parseScore(row, "agingRisk",       rowNum),
    shelterCapacity: parseScore(row, "shelterCapacity", rowNum),
    comment,
    actionTips: parseActionTips(row),
    sourceNote,
    postalCode:       parsePostalCode(row, rowNum),
    latitude:         parseOptionalNumber(row, "latitude",  rowNum, { min: -90,  max: 90  }),
    longitude:        parseOptionalNumber(row, "longitude", rowNum, { min: -180, max: 180 }),
    population:       parseOptionalNumber(row, "population", rowNum, { min: 0 }),
    agingRate:        parseOptionalNumber(row, "agingRate",  rowNum, { min: 0, max: 100 }),
    floodSource:      parseOptionalString(row, "floodSource"),
    earthquakeSource: parseOptionalString(row, "earthquakeSource"),
    fireSource:       parseOptionalString(row, "fireSource"),
    shelterSource:    parseOptionalString(row, "shelterSource"),
    dataUpdatedAt:    parseOptionalString(row, "dataUpdatedAt"),
    // Phase3
    isolationRisk:               parseOptionalNumber(row, "isolationRisk",               rowNum, { min: 0, max: 100 }),
    childcareStressRisk:         parseOptionalNumber(row, "childcareStressRisk",         rowNum, { min: 0, max: 100 }),
    emotionalRecoveryRisk:       parseOptionalNumber(row, "emotionalRecoveryRisk",       rowNum, { min: 0, max: 100 }),
    socialSupportScore:          parseOptionalNumber(row, "socialSupportScore",          rowNum, { min: 0, max: 100 }),
    infrastructureRecoveryScore: parseOptionalNumber(row, "infrastructureRecoveryScore", rowNum, { min: 0, max: 100 }),
    familyDisasterPreparedness:  parseOptionalNumber(row, "familyDisasterPreparedness",  rowNum, { min: 0, max: 100 }),
  };
}

// -------------------------------------------------------
// メイン処理
// -------------------------------------------------------

function main() {
  if (!fs.existsSync(CSV_INPUT_PATH)) {
    console.error(`❌ CSVファイルが見つかりません: ${CSV_INPUT_PATH}`);
    process.exit(1);
  }

  const content = fs.readFileSync(CSV_INPUT_PATH, "utf-8");

  const rows: Record<string, string>[] = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });

  if (rows.length === 0) {
    console.error("❌ CSVにデータ行がありません");
    process.exit(1);
  }

  const headers = Object.keys(rows[0]);
  const missingCols = REQUIRED_COLUMNS.filter((c) => !headers.includes(c));
  if (missingCols.length > 0) {
    console.error(`❌ 必須カラムが不足: ${missingCols.join(", ")}`);
    process.exit(1);
  }

  console.log(`ヘッダー: ${headers.join(", ")}`);
  console.log(`データ行数: ${rows.length}`);

  // 変換（1件でもエラーがあれば中断）
  const municipalities: Municipality[] = [];
  let hasError = false;

  for (let i = 0; i < rows.length; i++) {
    try {
      municipalities.push(rowToMunicipality(rows[i], i + 2));
    } catch (e) {
      console.error(`❌ ${(e as Error).message}`);
      hasError = true;
    }
  }

  if (hasError) {
    console.error("❌ エラーが発生したため変換を中断しました。CSVを修正してください。");
    process.exit(1);
  }

  // 重複IDチェック
  const idCounts = new Map<string, number>();
  for (const m of municipalities) {
    idCounts.set(m.id, (idCounts.get(m.id) ?? 0) + 1);
  }
  const duplicates = [...idCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id);
  if (duplicates.length > 0) {
    console.error(`❌ 重複IDが検出されました: ${duplicates.join(", ")}`);
    process.exit(1);
  }

  // municipalities.json 出力
  fs.writeFileSync(JSON_OUTPUT_PATH, JSON.stringify(municipalities, null, 2), "utf-8");
  console.log(`✅ ${municipalities.length}件を出力 → ${JSON_OUTPUT_PATH}`);

  // 軽量検索インデックスを同時更新
  const searchIndex: SearchIndexItem[] = municipalities.map((m) => ({
    id: m.id,
    prefecture: m.prefecture,
    municipality: m.municipality,
    overallScore: m.overallScore,
  }));
  fs.writeFileSync(
    SEARCH_INDEX_OUTPUT_PATH,
    JSON.stringify(searchIndex, null, 2),
    "utf-8"
  );
  console.log(`✅ 検索インデックスを出力 → ${SEARCH_INDEX_OUTPUT_PATH}`);
}

main();
