/**
 * 全国自治体マスター生成スクリプト
 *
 * 全国市区町村CSVから data/master/municipalities-base.json を生成する。
 * 既存の municipalities-base.json がある場合、jisCode が一致するエントリは
 * 既存スコア・コメント等を引き継ぎ、新規エントリにはデフォルト値（スコア 50）を設定する。
 *
 * 入力 CSV カラム:
 *   必須: jisCode（5桁）, prefecture, municipality
 *   任意: population, agingRate, latitude, longitude, id（省略時は muni-{jisCode}）
 *
 * 検証:
 *   - 必須フィールド空チェック
 *   - jisCode 5桁数字チェック
 *   - jisCode 重複（エラー）
 *   - id 重複（エラー）
 *   - jisCode が同じ行で prefecture/municipality が異なる（エラー）
 *
 * 使い方:
 *   npx tsx scripts/generate-national-master.ts \
 *     --input  data/raw/national/municipalities.csv \
 *     --output data/master/municipalities-base.json \
 *     [--base  data/master/municipalities-base.json]  # 既存データを引き継ぐ場合
 */

import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";

// -------------------------------------------------------
// 定数
// -------------------------------------------------------

const JIS_RE = /^\d{5}$/;

const REQUIRED_COLUMNS = ["jisCode", "prefecture", "municipality"] as const;

const DEFAULT_SCORES = {
  overallScore: 50,
  floodRisk: 50,
  earthquakeRisk: 50,
  fireRisk: 50,
  agingRisk: 50,
  shelterCapacity: 50,
  isolationRisk: 50,
  childcareStressRisk: 50,
  emotionalRecoveryRisk: 50,
  socialSupportScore: 50,
  infrastructureRecoveryScore: 50,
  familyDisasterPreparedness: 50,
};

// -------------------------------------------------------
// 型定義
// -------------------------------------------------------

interface CsvRow {
  jisCode: string;
  prefecture: string;
  municipality: string;
  population?: number;
  agingRate?: number;
  latitude?: number;
  longitude?: number;
  id?: string;
}

interface MunicipalityEntry {
  id: string;
  jisCode: string;
  prefecture: string;
  municipality: string;
  overallScore: number;
  floodRisk: number;
  earthquakeRisk: number;
  fireRisk: number;
  agingRisk: number;
  shelterCapacity: number;
  isolationRisk: number;
  childcareStressRisk: number;
  emotionalRecoveryRisk: number;
  socialSupportScore: number;
  infrastructureRecoveryScore: number;
  familyDisasterPreparedness: number;
  comment: string;
  actionTips: string[];
  sourceNote: string;
  population?: number;
  agingRate?: number;
  latitude?: number;
  longitude?: number;
}

// -------------------------------------------------------
// ID 生成
// -------------------------------------------------------

function generateId(jisCode: string): string {
  return `muni-${jisCode}`;
}

// -------------------------------------------------------
// CSV パース
// -------------------------------------------------------

function parseCsvRow(raw: Record<string, string>, rowIndex: number): {
  row: CsvRow | null;
  errors: string[];
} {
  const errors: string[] = [];

  function req(field: string): string {
    const v = (raw[field] ?? "").trim();
    if (!v) errors.push(`行${rowIndex}: [${field}] 必須フィールドが空です`);
    return v;
  }
  function optStr(field: string): string | undefined {
    const v = (raw[field] ?? "").trim();
    return v || undefined;
  }
  function optNum(field: string): number | undefined {
    const s = (raw[field] ?? "").trim();
    if (!s) return undefined;
    const v = Number(s);
    if (isNaN(v)) {
      errors.push(`行${rowIndex}: [${field}] 数値ではありません (${s})`);
      return undefined;
    }
    return v;
  }

  const jisCode     = req("jisCode");
  const prefecture  = req("prefecture");
  const municipality = req("municipality");

  if (jisCode && !JIS_RE.test(jisCode)) {
    errors.push(`行${rowIndex}: [jisCode] 5桁の数字である必要があります (${jisCode})`);
  }

  const id         = optStr("id");
  const population = optNum("population");
  const agingRate  = optNum("agingRate");
  const latitude   = optNum("latitude");
  const longitude  = optNum("longitude");

  // 数値範囲検証
  if (population !== undefined && population <= 0) {
    errors.push(`行${rowIndex}: [population] 正の数である必要があります (${population})`);
  }
  if (agingRate !== undefined && (agingRate < 0 || agingRate > 100)) {
    errors.push(`行${rowIndex}: [agingRate] 0〜100 の範囲である必要があります (${agingRate})`);
  }
  if (latitude !== undefined && (latitude < 20 || latitude > 46)) {
    errors.push(`行${rowIndex}: [latitude] 日本の緯度範囲外 [20, 46] (${latitude})`);
  }
  if (longitude !== undefined && (longitude < 122 || longitude > 154)) {
    errors.push(`行${rowIndex}: [longitude] 日本の経度範囲外 [122, 154] (${longitude})`);
  }

  if (errors.length > 0) return { row: null, errors };

  return {
    row: { jisCode, prefecture, municipality, id, population, agingRate, latitude, longitude },
    errors: [],
  };
}

// -------------------------------------------------------
// メイン処理
// -------------------------------------------------------

function generateNationalMaster(
  inputPath: string,
  outputPath: string,
  existingBasePath?: string,
): void {
  // 入力ファイルチェック
  if (!fs.existsSync(inputPath)) {
    throw new Error(`入力ファイルが見つかりません: ${inputPath}`);
  }

  // 既存マスター読み込み（jisCode でインデックス）
  const existingByJis = new Map<string, MunicipalityEntry>();
  const basePath = existingBasePath ?? outputPath;
  if (fs.existsSync(basePath)) {
    const existing: MunicipalityEntry[] = JSON.parse(fs.readFileSync(basePath, "utf-8"));
    for (const e of existing) {
      if (e.jisCode) existingByJis.set(e.jisCode, e);
    }
    console.log(`既存マスター読み込み: ${existingByJis.size}件 <- ${basePath}`);
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
  const missingCols = REQUIRED_COLUMNS.filter((c) => !headers.includes(c));
  if (missingCols.length > 0) {
    throw new Error(`必須カラムが不足しています: ${missingCols.join(", ")}`);
  }

  // 行バリデーション
  const csvRows: CsvRow[] = [];
  const allErrors: string[] = [];
  for (let i = 0; i < rawRows.length; i++) {
    const { row, errors } = parseCsvRow(rawRows[i], i + 2);
    allErrors.push(...errors);
    if (row) csvRows.push(row);
  }

  // jisCode 重複チェック
  const jisCount = new Map<string, string[]>();
  for (const r of csvRows) {
    const arr = jisCount.get(r.jisCode) ?? [];
    arr.push(r.municipality);
    jisCount.set(r.jisCode, arr);
  }
  for (const [jis, munis] of jisCount) {
    if (munis.length > 1) {
      allErrors.push(`jisCode 重複: ${jis} -> [${munis.join(", ")}]`);
    }
  }

  // 生成 ID 重複チェック（既存引き継ぎ優先順: r.id ?? existing.id ?? generateId）
  const idSet = new Set<string>();
  for (const r of csvRows) {
    const existing = existingByJis.get(r.jisCode);
    const id = existing
      ? (r.id ?? existing.id ?? generateId(r.jisCode))
      : (r.id ?? generateId(r.jisCode));
    if (idSet.has(id)) {
      allErrors.push(`ID 重複: ${id} (jisCode=${r.jisCode})`);
    }
    idSet.add(id);
  }

  if (allErrors.length > 0) {
    console.error(`\nバリデーションエラー (${allErrors.length}件):`);
    for (const e of allErrors) console.error(`  ❌ ${e}`);
    throw new Error("バリデーションエラーがあります。処理を中断します。");
  }

  console.log(`バリデーション OK: ${csvRows.length}件`);

  // エントリ生成
  let newCount = 0;
  let inheritedCount = 0;

  const entries: MunicipalityEntry[] = csvRows.map((r) => {
    const existing = existingByJis.get(r.jisCode);

    if (existing) {
      inheritedCount++;
      // 既存エントリを引き継ぎ; CSV の population/agingRate/lat/lon で上書き
      // ID 優先順: CSV の r.id > 既存の existing.id > generateId(jisCode)
      const id = r.id ?? existing.id ?? generateId(r.jisCode);
      return {
        ...existing,
        id,
        jisCode: r.jisCode,
        prefecture: r.prefecture,
        municipality: r.municipality,
        ...(r.population  !== undefined ? { population: r.population }   : {}),
        ...(r.agingRate   !== undefined ? { agingRate: r.agingRate }     : {}),
        ...(r.latitude    !== undefined ? { latitude: r.latitude }       : {}),
        ...(r.longitude   !== undefined ? { longitude: r.longitude }     : {}),
      };
    }

    // 新規エントリ: デフォルトスコア
    // ID 優先順: CSV の r.id > generateId(jisCode)
    newCount++;
    const id = r.id ?? generateId(r.jisCode);
    return {
      id,
      jisCode: r.jisCode,
      prefecture: r.prefecture,
      municipality: r.municipality,
      ...DEFAULT_SCORES,
      comment: `${r.municipality}の防災データを準備中です。`,
      actionTips: [
        "最寄りの避難所を確認しましょう",
        "非常用持ち出し袋を準備しましょう",
        "家族の連絡方法を確認しましょう",
      ],
      sourceNote: "避難所データはGSI指定避難所CSVを反映済みです。洪水・地震・火災・高齢化・孤立リスク等の一部指標は初期値・設計値を含みます。",
      ...(r.population  !== undefined ? { population: r.population }   : {}),
      ...(r.agingRate   !== undefined ? { agingRate: r.agingRate }     : {}),
      ...(r.latitude    !== undefined ? { latitude: r.latitude }       : {}),
      ...(r.longitude   !== undefined ? { longitude: r.longitude }     : {}),
    };
  });

  // 出力
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(entries, null, 2), "utf-8");

  console.log(`\n結果:`);
  console.log(`  新規エントリ  : ${newCount}件（デフォルトスコア 50 で初期化）`);
  console.log(`  既存引き継ぎ  : ${inheritedCount}件`);
  console.log(`  合計          : ${entries.length}件`);
  console.log(`  出力          : ${outputPath}`);

  const prefSet = new Set(entries.map((e) => e.prefecture));
  console.log(`  都道府県数    : ${prefSet.size}`);
}

// -------------------------------------------------------
// CLI
// -------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  const get  = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };

  const inputPath  = get("--input")  ?? "data/raw/national/municipalities.csv";
  const outputPath = get("--output") ?? "data/master/municipalities-base.json";
  const basePath   = get("--base");

  console.log(`\n=== 全国自治体マスター生成 ===`);
  console.log(`入力: ${inputPath}`);
  console.log(`出力: ${outputPath}`);
  if (basePath) console.log(`既存: ${basePath}`);
  console.log();

  try {
    generateNationalMaster(inputPath, outputPath, basePath);
    console.log("\n✅ 完了");
  } catch (e) {
    console.error(`\nERROR: ${(e as Error).message}`);
    process.exit(1);
  }
}
