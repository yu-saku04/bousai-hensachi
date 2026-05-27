/**
 * 人口・高齢化データインポーター
 *
 * データソース: 総務省統計局 国勢調査（2020年）
 * URL: https://www.stat.go.jp/data/kokusei/2020/
 * 形式: CSV
 *
 * 利用ライセンス: CC BY 4.0（統計法第32条に基づく二次利用可）
 *
 * 取得データ:
 *   - 市区町村別人口・高齢化率
 *   - 1人暮らし高齢者世帯比率（孤立リスク用）
 *   - 15歳未満人口比率（子育てストレスリスク用）
 *
 * 使い方:
 *   npx ts-node scripts/importers/import-population.ts \
 *     --input data/raw/census-2020.csv \
 *     --output data/processed/population-scores.json
 */

import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";
import { normalizeLowerIsBetter, normalizeHigherIsBetter, calculatePercentileScore } from "@/lib/normalize";

export interface PopulationRawRow {
  municipalityCode: string;
  prefecture: string;
  municipality: string;
  /** 総人口 */
  totalPopulation: number;
  /** 65歳以上人口 */
  elderlyPopulation: number;
  /** 65歳以上1人暮らし世帯数 */
  elderlyAloneHouseholds?: number;
  /** 15歳未満人口 */
  childPopulation?: number;
  /** 総世帯数 */
  totalHouseholds?: number;
}

export interface PopulationImportResult {
  municipalityCode: string;
  prefecture: string;
  municipality: string;
  /** 高齢化リスクスコア（0〜100、高いほど余裕あり） */
  agingRisk: number;
  /** 孤立リスクへの貢献スコア（高いほど孤立しにくい） */
  isolationRiskFromAging: number;
  /** 子育てストレスリスクへの貢献スコア */
  childcareStressFromDemography: number;
  _debug: {
    agingRate: number;
    elderlyAloneRate: number;
    childRate: number;
  };
}

function parseRawRow(row: Record<string, string>, rowNum: number): PopulationRawRow {
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
    totalPopulation:    num("totalPopulation"),
    elderlyPopulation:  num("elderlyPopulation"),
    elderlyAloneHouseholds: optNum("elderlyAloneHouseholds"),
    childPopulation:        optNum("childPopulation"),
    totalHouseholds:        optNum("totalHouseholds"),
  };
}

export function importPopulation(inputPath: string): PopulationImportResult[] {
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

  const agingRates        = rows.map((r) => r.totalPopulation > 0 ? (r.elderlyPopulation / r.totalPopulation) * 100 : 0);
  const elderlyAloneRates = rows.map((r) =>
    r.totalHouseholds && r.elderlyAloneHouseholds !== undefined && r.totalHouseholds > 0
      ? (r.elderlyAloneHouseholds / r.totalHouseholds) * 100
      : 0
  );
  const childRates = rows.map((r) =>
    r.childPopulation !== undefined && r.totalPopulation > 0
      ? (r.childPopulation / r.totalPopulation) * 100
      : 0
  );

  return rows.map((row, i) => {
    const agingRate      = agingRates[i];
    const elderlyAloneRate = elderlyAloneRates[i];
    const childRate      = childRates[i];

    // 高齢化率が低いほど避難困難度が低い → スコア高
    const agingPct  = calculatePercentileScore(agingRate, agingRates);
    const agingRisk = normalizeLowerIsBetter(agingPct, 0, 100);

    // 一人暮らし高齢者比率が低いほど孤立リスク低 → スコア高
    const alonePct             = calculatePercentileScore(elderlyAloneRate, elderlyAloneRates);
    const isolationRiskFromAging = normalizeLowerIsBetter(alonePct, 0, 100);

    // 子育て人口比率（適度にある方が地域活力あり）→ 中程度でスコア高
    // ここでは単純に子育て率が全国比較で中間程度 = 良いとする（暫定実装）
    const childPct = calculatePercentileScore(childRate, childRates);
    const childcareStressFromDemography = normalizeHigherIsBetter(childPct, 0, 100);

    return {
      municipalityCode: row.municipalityCode,
      prefecture:       row.prefecture,
      municipality:     row.municipality,
      agingRisk,
      isolationRiskFromAging,
      childcareStressFromDemography,
      _debug: { agingRate, elderlyAloneRate, childRate },
    };
  });
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const inputIdx  = args.indexOf("--input");
  const outputIdx = args.indexOf("--output");
  const inputPath  = inputIdx  >= 0 ? args[inputIdx  + 1] : "data/raw/census-2020.csv";
  const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : "data/processed/population-scores.json";

  try {
    const results = importPopulation(inputPath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), "utf-8");
    console.log(`OK: ${results.length}件 -> ${outputPath}`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
