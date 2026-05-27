/**
 * 土砂災害ハザードデータインポーター
 *
 * データソース: 国土交通省 砂防部 / 国土数値情報
 * URL: https://nrdb.mlit.go.jp/  /  https://nlftp.mlit.go.jp/
 * 形式: GeoJSON / CSV（市区町村別危険箇所数）
 *
 * 利用ライセンス: CC BY 4.0（国土交通省オープンデータ）
 *
 * 使い方:
 *   npx ts-node scripts/importers/import-hazard-landslide.ts \
 *     --input data/raw/landslide-hazard.csv \
 *     --output data/processed/landslide-scores.json
 */

import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";
import { normalizeLowerIsBetter, calculatePercentileScore } from "@/lib/normalize";

export interface LandslideRawRow {
  municipalityCode: string;
  prefecture: string;
  municipality: string;
  /** 土砂災害警戒区域数 */
  warningZoneCount: number;
  /** 土砂災害特別警戒区域数 */
  specialWarningZoneCount: number;
  /** 自治体面積（km2） */
  areaSqKm: number;
}

export interface LandslideImportResult {
  municipalityCode: string;
  prefecture: string;
  municipality: string;
  /** 孤立リスクへの貢献スコア（0〜100、高いほど安全） */
  landslideScore: number;
}

function parseRawRow(row: Record<string, string>, rowNum: number): LandslideRawRow {
  function num(key: string): number {
    const v = Number((row[key] ?? "").trim());
    if (isNaN(v)) throw new Error(`[行${rowNum}] ${key}: 数値でない値 "${row[key]}"`);
    return v;
  }
  return {
    municipalityCode:       (row["municipalityCode"] ?? "").trim(),
    prefecture:             (row["prefecture"]       ?? "").trim(),
    municipality:           (row["municipality"]     ?? "").trim(),
    warningZoneCount:        num("warningZoneCount"),
    specialWarningZoneCount: num("specialWarningZoneCount"),
    areaSqKm:                num("areaSqKm"),
  };
}

export function importLandslideHazard(inputPath: string): LandslideImportResult[] {
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

  // 面積あたり危険箇所密度（低いほど安全）
  const densities = rows.map((r) =>
    r.areaSqKm > 0
      ? (r.warningZoneCount + r.specialWarningZoneCount * 2) / r.areaSqKm
      : 0
  );

  return rows.map((row, i) => ({
    municipalityCode: row.municipalityCode,
    prefecture:       row.prefecture,
    municipality:     row.municipality,
    landslideScore: normalizeLowerIsBetter(
      calculatePercentileScore(densities[i], densities),
      0,
      100
    ),
  }));
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const inputIdx  = args.indexOf("--input");
  const outputIdx = args.indexOf("--output");
  const inputPath  = inputIdx  >= 0 ? args[inputIdx  + 1] : "data/raw/landslide-hazard.csv";
  const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : "data/processed/landslide-scores.json";

  try {
    const results = importLandslideHazard(inputPath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), "utf-8");
    console.log(`OK: ${results.length}件 -> ${outputPath}`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
