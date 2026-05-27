/**
 * 避難所データインポーター（全国CSV対応版）
 *
 * データソース:
 *   - 国土地理院 指定緊急避難場所データ: https://www.gsi.go.jp/bousaichiri/hinanbasho.html
 *   - 東京都オープンデータカタログ: https://catalog.data.metro.tokyo.lg.jp/
 *   - 取り込み仕様詳細: data/raw/national/README.md
 *
 * CSVフォーマット（data/raw/national/README.md 参照）:
 *   必須: jisCode, prefecture, municipality, shelterName, sourceUrl, updatedAt
 *   推奨: capacity, disasterTypes, address, latitude, longitude
 *
 * 検証内容:
 *   - 必須カラム存在チェック（jisCode / prefecture / municipality / shelterName / sourceUrl / updatedAt）
 *   - capacity: 正の整数（欠損時は 0 として集計し warning）
 *   - latitude / longitude: 任意。存在する場合のみ日本範囲チェック (20〜46N, 122〜154E)
 *   - updatedAt: YYYY-MM-DD 形式（必須・欠損は error）
 *   - sourceUrl: http(s):// から始まるURL（必須・欠損は error）
 *   - jisCode: 5桁数字
 *   - disasterTypes: パイプ区切り、既知タイプのみ（欠損時は ["unknown"] を設定）
 *   - 同一 jisCode 内の prefecture/municipality 混在チェック（error）
 *
 * 出力フィールド:
 *   - sourceUrls: string[]  全施設のURLを重複なしで保持
 *   - calculationVersion: "shelter-v1"  スコア算出ロジックのバージョン
 *
 * 使い方:
 *   npx tsx scripts/importers/import-shelters.ts \
 *     --input data/raw/national/shelters.csv \
 *     --output data/processed/shelters.json \
 *     [--municipalities data/master/municipalities-base.json]
 */

import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";
import { calcShelterCapacityScore } from "@/lib/normalize";

// -------------------------------------------------------
// 定数
// -------------------------------------------------------

const REQUIRED_COLUMNS = [
  "jisCode", "prefecture", "municipality", "shelterName",
  "sourceUrl", "updatedAt",
] as const;

const KNOWN_DISASTER_TYPES = new Set([
  "earthquake", "flood", "fire", "tsunami", "volcano",
  "landslide", "storm", "inland_flood", "unknown",
]);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const URL_RE = /^https?:\/\/.+/;
const JIS_RE = /^\d{5}$/;

const LAT_MIN = 20, LAT_MAX = 46;
const LON_MIN = 122, LON_MAX = 154;

// -------------------------------------------------------
// 型定義
// -------------------------------------------------------

interface ShelterRow {
  jisCode: string;
  prefecture: string;
  municipality: string;
  shelterName: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  capacity: number;
  disasterTypes: string[];
  sourceUrl: string;
  updatedAt: string;
}

export interface ShelterImportResult {
  jisCode: string;
  prefecture: string;
  municipality: string;
  shelterCount: number;
  totalCapacity: number;
  /** 人口1万人あたりの避難所数。population データがない場合 null。 */
  sheltersPerTenThousand: number | null;
  /** 人口1人あたりの収容人数。population データがない場合 null。 */
  capacityPerPopulation: number | null;
  /** 対応災害種別の Union（全施設の合計） */
  disasterTypes: string[];
  /** 代表出典URL（最初の sourceUrl） */
  sourceUrl: string;
  /** 全施設の出典URL（重複なし） */
  sourceUrls: string[];
  updatedAt: string;
  /** shelterCapacity スコア（0〜100、高いほど余裕あり） */
  shelterCapacity: number;
  /** スコア算出ロジックのバージョン */
  calculationVersion: "shelter-v1";
}

interface PopEntry {
  jisCode?: string;
  prefecture: string;
  municipality: string;
  population: number;
}

// -------------------------------------------------------
// バリデーション
// -------------------------------------------------------

interface RowError {
  row: number;
  field: string;
  message: string;
  value: unknown;
}

function validateHeader(headers: string[]): string[] {
  const missing: string[] = [];
  for (const col of REQUIRED_COLUMNS) {
    if (!headers.includes(col)) missing.push(col);
  }
  return missing;
}

interface RowWarning {
  row: number;
  field: string;
  message: string;
}

interface WarningSummary {
  capacityMissing: number;
  disasterTypesMissing: number;
  total: number;
  examples: RowWarning[];
}

function parseRow(raw: Record<string, string>, rowIndex: number): {
  row: ShelterRow | null;
  errors: RowError[];
  warnings: RowWarning[];
} {
  const errors: RowError[] = [];
  const warnings: RowWarning[] = [];

  function req(field: string): string {
    const v = (raw[field] ?? "").trim();
    if (!v) errors.push({ row: rowIndex, field, message: "必須フィールドが空です", value: v });
    return v;
  }
  function optStr(field: string): string | undefined {
    const v = (raw[field] ?? "").trim();
    return v || undefined;
  }
  function optNum(field: string): number | undefined {
    const raw2 = (raw[field] ?? "").trim();
    if (!raw2) return undefined;
    const v = Number(raw2);
    if (isNaN(v)) {
      errors.push({ row: rowIndex, field, message: "数値ではありません", value: raw2 });
      return undefined;
    }
    return v;
  }

  const jisCode      = req("jisCode");
  const prefecture   = req("prefecture");
  const municipality = req("municipality");
  const shelterName  = req("shelterName");
  const sourceUrl    = req("sourceUrl");
  const updatedAt    = req("updatedAt");

  // jisCode: 5桁数字
  if (jisCode && !JIS_RE.test(jisCode)) {
    errors.push({ row: rowIndex, field: "jisCode", message: "5桁の数字である必要があります", value: jisCode });
  }

  // sourceUrl: URL形式（必須・欠損は error）
  if (sourceUrl && !URL_RE.test(sourceUrl)) {
    errors.push({ row: rowIndex, field: "sourceUrl", message: "http(s):// から始まるURLである必要があります", value: sourceUrl });
  }

  // updatedAt: YYYY-MM-DD（必須・欠損は error）
  if (updatedAt && !DATE_RE.test(updatedAt)) {
    errors.push({ row: rowIndex, field: "updatedAt", message: "YYYY-MM-DD 形式である必要があります", value: updatedAt });
  }

  // latitude / longitude (任意: 存在する場合のみ範囲チェック)
  const latitude  = optNum("latitude");
  const longitude = optNum("longitude");

  if (latitude !== undefined && (latitude < LAT_MIN || latitude > LAT_MAX)) {
    errors.push({ row: rowIndex, field: "latitude", message: `日本の緯度範囲外 [${LAT_MIN}, ${LAT_MAX}]`, value: latitude });
  }
  if (longitude !== undefined && (longitude < LON_MIN || longitude > LON_MAX)) {
    errors.push({ row: rowIndex, field: "longitude", message: `日本の経度範囲外 [${LON_MIN}, ${LON_MAX}]`, value: longitude });
  }

  // capacity: 推奨（欠損時は 0 として集計し warning）
  const capacityRaw = (raw["capacity"] ?? "").trim();
  let capacity = 0;
  if (!capacityRaw) {
    warnings.push({ row: rowIndex, field: "capacity", message: "欠損のため 0 として集計します" });
  } else {
    const n = Number(capacityRaw);
    if (isNaN(n) || n < 0 || !Number.isInteger(n)) {
      errors.push({ row: rowIndex, field: "capacity", message: "0以上の整数である必要があります", value: capacityRaw });
    } else {
      capacity = n;
    }
  }

  // disasterTypes: 推奨（欠損時は ["unknown"]）
  const disasterRaw = (raw["disasterTypes"] ?? "").trim();
  let disasterTypes: string[];
  if (!disasterRaw) {
    disasterTypes = ["unknown"];
    warnings.push({ row: rowIndex, field: "disasterTypes", message: "未設定のため unknown を設定します" });
  } else {
    disasterTypes = disasterRaw.split("|").map((t) => t.trim()).filter(Boolean);
    for (const t of disasterTypes) {
      if (!KNOWN_DISASTER_TYPES.has(t)) {
        errors.push({ row: rowIndex, field: "disasterTypes", message: `未知の災害種別: ${t}`, value: t });
      }
    }
  }

  if (errors.length > 0) return { row: null, errors, warnings };

  return {
    row: {
      jisCode,
      prefecture,
      municipality,
      shelterName,
      address: optStr("address"),
      latitude,
      longitude,
      capacity,
      disasterTypes,
      sourceUrl,
      updatedAt,
    },
    errors: [],
    warnings,
  };
}

// -------------------------------------------------------
// メイン処理
// -------------------------------------------------------

export function importShelters(
  inputPath: string,
  outputPath: string,
  municipalitiesPath?: string,
): ShelterImportResult[] {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`入力ファイルが見つかりません: ${inputPath}`);
  }

  // 人口データ読み込み（任意）
  // jisCode 優先、なければ prefecture_municipality フォールバック
  const popByJisCode  = new Map<string, number>();
  const popByMuniKey  = new Map<string, number>();
  const popFile = municipalitiesPath ?? "data/master/municipalities-base.json";
  if (fs.existsSync(popFile)) {
    const muni: PopEntry[] = JSON.parse(fs.readFileSync(popFile, "utf-8"));
    for (const m of muni) {
      if (typeof m.population === "number" && m.population > 0) {
        if (m.jisCode) popByJisCode.set(m.jisCode, m.population);
        popByMuniKey.set(`${m.prefecture}_${m.municipality}`, m.population);
      }
    }
    console.log(`人口データ読み込み: jisCode=${popByJisCode.size}件 / muniKey=${popByMuniKey.size}件 <- ${popFile}`);
  }

  // CSV パース
  const content = fs.readFileSync(inputPath, "utf-8");
  const rawRows: Record<string, string>[] = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });

  if (rawRows.length === 0) throw new Error("CSVが空です");

  // ヘッダー検証
  const headers = Object.keys(rawRows[0]);
  const missingCols = validateHeader(headers);
  if (missingCols.length > 0) {
    throw new Error(`必須カラムが不足しています: ${missingCols.join(", ")}`);
  }

  // 行バリデーション
  const rows: ShelterRow[] = [];
  let errorCount = 0;
  const warningSummary: WarningSummary = {
    capacityMissing: 0,
    disasterTypesMissing: 0,
    total: 0,
    examples: [],
  };
  for (let i = 0; i < rawRows.length; i++) {
    const { row, errors, warnings } = parseRow(rawRows[i], i + 2); // +2 for 1-index + header row
    if (errors.length > 0) {
      for (const e of errors) {
        console.error(`  行${e.row}: [${e.field}] ${e.message} (値: ${e.value})`);
      }
      errorCount++;
    } else if (row) {
      rows.push(row);
    }
    if (warnings.length > 0) {
      for (const w of warnings) {
        if (w.field === "capacity") warningSummary.capacityMissing++;
        if (w.field === "disasterTypes") warningSummary.disasterTypesMissing++;
        if (warningSummary.examples.length < 20) warningSummary.examples.push(w);
      }
      warningSummary.total += warnings.length;
    }
  }
  if (errorCount > 0) {
    throw new Error(`バリデーションエラー: ${errorCount}行`);
  }
  if (warningSummary.total > 0) {
    console.warn("\n警告サマリー:");
    console.warn(`  capacity欠損件数: ${warningSummary.capacityMissing}`);
    console.warn(`  disasterTypes欠損件数: ${warningSummary.disasterTypesMissing}`);
    console.warn(`  具体例（先頭${warningSummary.examples.length}件 / 最大20件）:`);
    for (const w of warningSummary.examples) {
      console.warn(`    ⚠️  行${w.row}: [${w.field}] ${w.message}`);
    }
    console.warn(`  合計warning: ${warningSummary.total}件（処理は継続）`);
  }
  console.log(`バリデーション OK: ${rows.length}件`);

  // 市区町村単位で集計
  const groups = new Map<string, ShelterRow[]>();
  for (const row of rows) {
    const key = row.jisCode;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  // 同一 jisCode に異なる prefecture/municipality が混在していないか検証
  const mixErrors: string[] = [];
  for (const [jisCode, shelters] of groups) {
    const prefectures  = new Set(shelters.map((s) => s.prefecture));
    const municipalities = new Set(shelters.map((s) => s.municipality));
    if (prefectures.size > 1) {
      mixErrors.push(
        `jisCode ${jisCode}: prefecture が混在 → [${[...prefectures].join(", ")}]`
      );
    }
    if (municipalities.size > 1) {
      mixErrors.push(
        `jisCode ${jisCode}: municipality が混在 → [${[...municipalities].join(", ")}]`
      );
    }
  }
  if (mixErrors.length > 0) {
    for (const e of mixErrors) console.error(`  ❌ ${e}`);
    throw new Error(`同一jisCode混在エラー: ${mixErrors.length}件`);
  }

  // 集計
  const aggregated = Array.from(groups.entries()).map(([jisCode, shelters]) => {
    const first        = shelters[0];
    const shelterCount = shelters.length;
    const totalCapacity = shelters.reduce((s, r) => s + r.capacity, 0);
    const muniKey      = `${first.prefecture}_${first.municipality}`;
    const population   = popByJisCode.get(jisCode) ?? popByMuniKey.get(muniKey) ?? null;

    const sheltersPerTenThousand = population !== null
      ? (shelterCount / population) * 10_000
      : null;
    const capacityPerPopulation = population !== null
      ? totalCapacity / population
      : null;

    // 全施設の disaster types を Union して dedupe
    const disasterSet = new Set<string>();
    for (const s of shelters) s.disasterTypes.forEach((t) => disasterSet.add(t));

    // sourceUrls: 全施設のURLを重複なしで保持
    const sourceUrlSet = new Set<string>();
    for (const s of shelters) sourceUrlSet.add(s.sourceUrl);
    const sourceUrls = [...sourceUrlSet].sort();

    // sourceUrl: 代表値（最初の値）
    const sourceUrl = first.sourceUrl;

    const updatedAt = shelters
      .map((s) => s.updatedAt)
      .sort()
      .at(-1) ?? first.updatedAt; // 最新の updatedAt を使用

    return {
      jisCode,
      prefecture:  first.prefecture,
      municipality: first.municipality,
      shelterCount,
      totalCapacity,
      sheltersPerTenThousand,
      capacityPerPopulation,
      disasterTypes: [...disasterSet].sort(),
      sourceUrl,
      sourceUrls,
      updatedAt,
    };
  });

  // shelterCapacity スコア計算（全自治体を一括評価）
  const perTenKDataset = aggregated.map((a) => a.sheltersPerTenThousand);
  const totalCapDataset = aggregated.map((a) => a.totalCapacity);

  const results: ShelterImportResult[] = aggregated.map((a) => ({
    ...a,
    shelterCapacity: calcShelterCapacityScore(
      a.sheltersPerTenThousand,
      perTenKDataset,
      a.totalCapacity,
      totalCapDataset,
    ),
    calculationVersion: "shelter-v1" as const,
  }));

  // 出力
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), "utf-8");

  return results;
}

// -------------------------------------------------------
// CLI
// -------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  const get  = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };

  const inputPath  = get("--input")         ?? "data/raw/tokyo-23/shelters.template.csv";
  const outputPath = get("--output")        ?? "data/processed/shelters.json";
  const muniPath   = get("--municipalities");

  try {
    console.log(`\n=== 避難所データインポート ===`);
    console.log(`入力: ${inputPath}`);
    console.log(`出力: ${outputPath}\n`);

    const results = importShelters(inputPath, outputPath, muniPath);

    console.log(`\n結果サマリー:`);
    for (const r of results) {
      const perTenK = r.sheltersPerTenThousand !== null
        ? r.sheltersPerTenThousand.toFixed(3)
        : "N/A";
      console.log(
        `  ${r.prefecture} ${r.municipality}: ` +
        `施設数=${r.shelterCount}, 総収容=${r.totalCapacity}人, ` +
        `1万人あたり=${perTenK}, shelterCapacity=${r.shelterCapacity}`
      );
    }
    console.log(`\nOK: ${results.length}自治体 -> ${outputPath}`);
  } catch (e) {
    console.error(`\nERROR: ${(e as Error).message}`);
    process.exit(1);
  }
}
