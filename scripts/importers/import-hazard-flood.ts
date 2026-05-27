/**
 * 洪水ハザードデータインポーター
 *
 * データソース: 国土交通省 ハザードマップポータルサイト
 * URL: https://disaportal.gsi.go.jp/
 * 形式: GeoJSON / CSV（市区町村別浸水深集計）
 *
 * 利用ライセンス: CC BY 4.0（国土交通省オープンデータ）
 *
 * 使い方:
 *   npx ts-node scripts/importers/import-hazard-flood.ts \
 *     --input data/raw/flood-hazard.csv \
 *     --output data/processed/flood-scores.json
 */

import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";
import { normalizeLowerIsBetter, calculatePercentileScore, stdDev } from "@/lib/normalize";

// -------------------------------------------------------
// 型定義
// -------------------------------------------------------

/** CSVから読み込む生データ行 */
export interface FloodHazardRawRow {
  /** JIS市区町村コード（5桁） */
  municipalityCode: string;
  prefecture: string;
  municipality: string;
  /** 計画規模の最大浸水深（m） */
  maxFloodDepthPlan: number;
  /** 想定最大規模の最大浸水深（m） */
  maxFloodDepthMax: number;
  /** 浸水面積率（自治体面積に対する割合 0〜100%） */
  floodAreaRatePlan: number;
  /** 想定浸水人口（人） */
  estimatedFloodPopulation?: number;
}

/** インポート結果 */
export interface FloodImportResult {
  municipalityCode: string;
  prefecture: string;
  municipality: string;
  /** 洪水リスクスコア（0〜100、高いほど安全） */
  floodRisk: number;
  /** デバッグ用: 算出に使用した値 */
  _debug: {
    maxFloodDepthPlan: number;
    floodAreaRatePlan: number;
    depthScore: number;
    areaScore: number;
  };
}

export interface FloodImportOptions {
  /** 重み: 浸水深スコア（デフォルト 0.6） */
  depthWeight?: number;
  /** 重み: 浸水面積率スコア（デフォルト 0.4） */
  areaWeight?: number;
}

// -------------------------------------------------------
// パーサー
// -------------------------------------------------------

function parseRawRow(row: Record<string, string>, rowNum: number): FloodHazardRawRow {
  function num(key: string): number {
    const v = Number((row[key] ?? "").trim());
    if (isNaN(v)) throw new Error(`[行${rowNum}] ${key}: 数値でない値 "${row[key]}"`);
    return v;
  }
  function optNum(key: string): number | undefined {
    const raw = (row[key] ?? "").trim();
    if (!raw) return undefined;
    const v = Number(raw);
    return isNaN(v) ? undefined : v;
  }
  return {
    municipalityCode: (row["municipalityCode"] ?? "").trim(),
    prefecture:       (row["prefecture"]       ?? "").trim(),
    municipality:     (row["municipality"]     ?? "").trim(),
    maxFloodDepthPlan: num("maxFloodDepthPlan"),
    maxFloodDepthMax:  num("maxFloodDepthMax"),
    floodAreaRatePlan: num("floodAreaRatePlan"),
    estimatedFloodPopulation: optNum("estimatedFloodPopulation"),
  };
}

// -------------------------------------------------------
// スコア計算
// -------------------------------------------------------

function calcFloodScore(rows: FloodHazardRawRow[], opts: FloodImportOptions): FloodImportResult[] {
  const depthWeight = opts.depthWeight ?? 0.6;
  const areaWeight  = opts.areaWeight  ?? 0.4;

  const depths = rows.map((r) => r.maxFloodDepthPlan);
  const areas  = rows.map((r) => r.floodAreaRatePlan);

  return rows.map((row) => {
    // 浸水深: 低いほど安全（0m〜10mで正規化、パーセンタイル補正）
    const depthPct   = calculatePercentileScore(row.maxFloodDepthPlan, depths);
    const depthScore = normalizeLowerIsBetter(depthPct, 0, 100);

    // 浸水面積率: 低いほど安全（0〜100%で正規化）
    const areaPct   = calculatePercentileScore(row.floodAreaRatePlan, areas);
    const areaScore = normalizeLowerIsBetter(areaPct, 0, 100);

    const floodRisk = Math.round(depthScore * depthWeight + areaScore * areaWeight);

    return {
      municipalityCode: row.municipalityCode,
      prefecture:       row.prefecture,
      municipality:     row.municipality,
      floodRisk,
      _debug: { maxFloodDepthPlan: row.maxFloodDepthPlan, floodAreaRatePlan: row.floodAreaRatePlan, depthScore, areaScore },
    };
  });
}

// -------------------------------------------------------
// メイン
// -------------------------------------------------------

export function importFloodHazard(
  inputPath: string,
  opts: FloodImportOptions = {}
): FloodImportResult[] {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`入力ファイルが見つかりません: ${inputPath}`);
  }
  const content = fs.readFileSync(inputPath, "utf-8");
  const rawRows: Record<string, string>[] = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });

  const rows = rawRows.map((r, i) => parseRawRow(r, i + 2));
  return calcFloodScore(rows, opts);
}

// CLI 実行
if (require.main === module) {
  const args = process.argv.slice(2);
  const inputIdx  = args.indexOf("--input");
  const outputIdx = args.indexOf("--output");
  const inputPath  = inputIdx  >= 0 ? args[inputIdx  + 1] : "data/raw/flood-hazard.csv";
  const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : "data/processed/flood-scores.json";

  try {
    const results = importFloodHazard(inputPath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), "utf-8");
    console.log(`OK: ${results.length}件 -> ${outputPath}`);
    // 統計サマリー
    const scores = results.map((r) => r.floodRisk);
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    console.log(`  平均スコア: ${avg.toFixed(1)} / 標準偏差: ${stdDev(scores).toFixed(1)}`);
    console.log(`  最小: ${Math.min(...scores)} / 最大: ${Math.max(...scores)}`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
