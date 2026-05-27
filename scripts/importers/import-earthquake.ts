/**
 * 地震リスクデータインポーター
 *
 * データソース: 地震調査研究推進本部 / 防災科学技術研究所 J-SHIS
 * URL: https://www.j-shis.bosai.go.jp/
 * 形式: CSV（250mメッシュ → 市区町村集計）
 *
 * 利用ライセンス: CC BY 4.0（防災科研）
 *
 * 前処理について:
 *   J-SHISのメッシュデータを市区町村単位に集計してからこのスクリプトを使用する。
 *   集計方法: 市区町村内メッシュの人口加重平均を推奨。
 *
 * 使い方:
 *   npx ts-node scripts/importers/import-earthquake.ts \
 *     --input data/raw/earthquake-risk.csv \
 *     --output data/processed/earthquake-scores.json
 */

import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";
import { normalizeLowerIsBetter, calculatePercentileScore } from "@/lib/normalize";

export interface EarthquakeRawRow {
  municipalityCode: string;
  prefecture: string;
  municipality: string;
  /** 30年以内に震度6弱以上となる確率（%） */
  prob30YrShindo6: number;
  /** 30年以内に震度5強以上となる確率（%） */
  prob30YrShindo5: number;
  /** 最大加速度の中央値（gal） */
  peakGroundAccelerationMedian?: number;
  /** 液状化リスク指数（高いほどリスク大） */
  liquefactionIndex?: number;
}

export interface EarthquakeImportResult {
  municipalityCode: string;
  prefecture: string;
  municipality: string;
  /** 地震リスクスコア（0〜100、高いほど安全） */
  earthquakeRisk: number;
  _debug: {
    prob30YrShindo6: number;
    shindoScore: number;
    liquefactionScore: number | null;
  };
}

export interface EarthquakeImportOptions {
  /** 震度確率スコアの重み（デフォルト 0.7） */
  shindoWeight?: number;
  /** 液状化スコアの重み（デフォルト 0.3） */
  liquefactionWeight?: number;
}

function parseRawRow(row: Record<string, string>, rowNum: number): EarthquakeRawRow {
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
    municipalityCode:           (row["municipalityCode"] ?? "").trim(),
    prefecture:                 (row["prefecture"]       ?? "").trim(),
    municipality:               (row["municipality"]     ?? "").trim(),
    prob30YrShindo6:             num("prob30YrShindo6"),
    prob30YrShindo5:             num("prob30YrShindo5"),
    peakGroundAccelerationMedian: optNum("peakGroundAccelerationMedian"),
    liquefactionIndex:            optNum("liquefactionIndex"),
  };
}

export function importEarthquake(
  inputPath: string,
  opts: EarthquakeImportOptions = {}
): EarthquakeImportResult[] {
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

  const shindoWeight       = opts.shindoWeight       ?? 0.7;
  const liquefactionWeight = opts.liquefactionWeight ?? 0.3;

  const shindoProbs      = rows.map((r) => r.prob30YrShindo6);
  const liquefactions    = rows.map((r) => r.liquefactionIndex).filter((v): v is number => v !== undefined);
  const hasLiquefaction  = liquefactions.length === rows.length;

  return rows.map((row) => {
    const shindoPct   = calculatePercentileScore(row.prob30YrShindo6, shindoProbs);
    const shindoScore = normalizeLowerIsBetter(shindoPct, 0, 100);

    let earthquakeRisk: number;
    let liquefactionScore: number | null = null;

    if (hasLiquefaction && row.liquefactionIndex !== undefined) {
      const liqPct     = calculatePercentileScore(row.liquefactionIndex, liquefactions);
      liquefactionScore = normalizeLowerIsBetter(liqPct, 0, 100);
      earthquakeRisk    = Math.round(shindoScore * shindoWeight + liquefactionScore * liquefactionWeight);
    } else {
      earthquakeRisk = shindoScore;
    }

    return {
      municipalityCode: row.municipalityCode,
      prefecture:       row.prefecture,
      municipality:     row.municipality,
      earthquakeRisk,
      _debug: { prob30YrShindo6: row.prob30YrShindo6, shindoScore, liquefactionScore },
    };
  });
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const inputIdx  = args.indexOf("--input");
  const outputIdx = args.indexOf("--output");
  const inputPath  = inputIdx  >= 0 ? args[inputIdx  + 1] : "data/raw/earthquake-risk.csv";
  const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : "data/processed/earthquake-scores.json";

  try {
    const results = importEarthquake(inputPath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), "utf-8");
    console.log(`OK: ${results.length}件 -> ${outputPath}`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
