/**
 * 火災リスクデータインポーター
 *
 * データソース: 消防庁 火災統計（市区町村別）
 * URL: https://www.fdma.go.jp/publication/statistics/
 * 形式: CSV / Excel（年次別市区町村別火災発生件数）
 *
 * 利用ライセンス: 政府標準利用規約（CC BY 4.0相当）
 *
 * 前処理について:
 *   複数年のExcelを統合し、市区町村コード・発生件数・死者数のCSVを用意すること。
 *   直近5年分の平均を推奨（年変動の平滑化のため）。
 *
 * 使い方:
 *   npx ts-node scripts/importers/import-fire.ts \
 *     --input data/raw/fire-statistics.csv \
 *     --output data/processed/fire-scores.json
 */

import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";
import { normalizeLowerIsBetter, calculatePercentileScore } from "@/lib/normalize";

export interface FireRawRow {
  municipalityCode: string;
  prefecture: string;
  municipality: string;
  /** 人口（火災発生率計算用） */
  population: number;
  /** 建物数（建物あたり発生率計算用） */
  buildingCount?: number;
  /** 火災発生件数（集計期間の合計または平均） */
  fireCount: number;
  /** 火災死者数 */
  fireDeaths?: number;
  /** 集計年数（平均化に使用） */
  years?: number;
}

export interface FireImportResult {
  municipalityCode: string;
  prefecture: string;
  municipality: string;
  /** 火災リスクスコア（0〜100、高いほど安全） */
  fireRisk: number;
  _debug: {
    fireRatePer10k: number;
    fireScore: number;
  };
}

function parseRawRow(row: Record<string, string>, rowNum: number): FireRawRow {
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
    population:        num("population"),
    buildingCount:    optNum("buildingCount"),
    fireCount:         num("fireCount"),
    fireDeaths:       optNum("fireDeaths"),
    years:            optNum("years"),
  };
}

export function importFire(inputPath: string): FireImportResult[] {
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

  // 人口10,000人あたり年間火災発生率
  const fireRates = rows.map((row) => {
    const annualFires = row.fireCount / (row.years ?? 1);
    return row.population > 0 ? (annualFires / row.population) * 10000 : 0;
  });

  return rows.map((row, i) => {
    const fireRatePer10k = fireRates[i];
    const firePct        = calculatePercentileScore(fireRatePer10k, fireRates);
    const fireScore      = normalizeLowerIsBetter(firePct, 0, 100);

    return {
      municipalityCode: row.municipalityCode,
      prefecture:       row.prefecture,
      municipality:     row.municipality,
      fireRisk: fireScore,
      _debug: { fireRatePer10k, fireScore },
    };
  });
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const inputIdx  = args.indexOf("--input");
  const outputIdx = args.indexOf("--output");
  const inputPath  = inputIdx  >= 0 ? args[inputIdx  + 1] : "data/raw/fire-statistics.csv";
  const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : "data/processed/fire-scores.json";

  try {
    const results = importFire(inputPath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), "utf-8");
    console.log(`OK: ${results.length}件 -> ${outputPath}`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
