/**
 * 人口データインポーター (population-v1)
 *
 * データソース候補:
 *   - 総務省統計局 国勢調査（2020年）
 *     https://www.stat.go.jp/data/kokusei/2020/
 *   - 住民基本台帳人口・世帯数調査（毎年3月末時点）
 *     https://www.soumu.go.jp/main_sosiki/jichi_gyousei/daityo/jinkou_jichi.html
 *
 * 入力CSV: data/raw/national/population.csv
 *   カラム: jisCode,prefecture,municipality,population,sourceUrl,updatedAt
 *
 * 出力: data/processed/population.json
 *   形式: PopulationEntry[]（calculationVersion: "population-v1"）
 *
 * 使い方:
 *   npm run import:population
 *   tsx scripts/importers/import-population.ts [--input PATH] [--output PATH] [--master PATH]
 */

import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";

const JIS_RE  = /^\d{5}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, mo, d] = s.split("-").map(Number);
  const dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
}

export interface PopulationEntry {
  jisCode: string;
  prefecture: string;
  municipality: string;
  population: number;
  sourceUrl: string;
  updatedAt: string;
  calculationVersion: "population-v1";
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function importPopulationCsv(
  inputPath: string,
  masterPath?: string,
): PopulationEntry[] {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`入力ファイルが見つかりません: ${inputPath}`);
  }

  let masterJisCodes: Set<string> | null = null;
  if (masterPath) {
    if (!fs.existsSync(masterPath)) {
      throw new Error(`masterファイルが見つかりません: ${masterPath}`);
    }
    const master = JSON.parse(
      fs.readFileSync(masterPath, "utf-8"),
    ) as Array<{ jisCode?: string }>;
    masterJisCodes = new Set(
      master.map((m) => m.jisCode).filter((c): c is string => typeof c === "string"),
    );
  }

  const content = fs.readFileSync(inputPath, "utf-8");
  const rows: Record<string, string>[] = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });

  const errors: string[] = [];
  const results: PopulationEntry[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2;

    const jisCode      = (row["jisCode"]      ?? "").trim();
    const prefecture   = (row["prefecture"]   ?? "").trim();
    const municipality = (row["municipality"] ?? "").trim();
    const populationRaw = (row["population"]  ?? "").trim();
    const sourceUrl    = (row["sourceUrl"]    ?? "").trim();
    const updatedAt    = (row["updatedAt"]    ?? "").trim();

    let hasError = false;

    if (!JIS_RE.test(jisCode)) {
      errors.push(`[行${rowNum}] jisCode: 5桁数字必須 "${jisCode}"`);
      hasError = true;
    } else if (masterJisCodes && !masterJisCodes.has(jisCode)) {
      errors.push(`[行${rowNum}] jisCode: masterに存在しないコード "${jisCode}" (${prefecture} ${municipality})`);
      hasError = true;
    }

    if (!prefecture) {
      errors.push(`[行${rowNum}] prefecture: 必須`);
      hasError = true;
    }

    if (!municipality) {
      errors.push(`[行${rowNum}] municipality: 必須`);
      hasError = true;
    }

    const population = Number(populationRaw);
    if (!populationRaw || isNaN(population) || !Number.isInteger(population) || population <= 0) {
      errors.push(`[行${rowNum}] population: 正の整数必須 "${populationRaw}"`);
      hasError = true;
    }

    if (!isHttpUrl(sourceUrl)) {
      errors.push(`[行${rowNum}] sourceUrl: http(s) URL必須 "${sourceUrl}"`);
      hasError = true;
    }

    if (!isValidDate(updatedAt)) {
      errors.push(`[行${rowNum}] updatedAt: 実在するYYYY-MM-DD必須 "${updatedAt}"`);
      hasError = true;
    }

    if (!hasError) {
      results.push({
        jisCode,
        prefecture,
        municipality,
        population,
        sourceUrl,
        updatedAt,
        calculationVersion: "population-v1",
      });
    }
  }

  // jisCode 重複スキャン（形式が正しい行のみ対象）
  const jisCodeRows = new Map<string, number[]>();
  for (let i = 0; i < rows.length; i++) {
    const jisCode = (rows[i]["jisCode"] ?? "").trim();
    if (!JIS_RE.test(jisCode)) continue;
    const existing = jisCodeRows.get(jisCode) ?? [];
    existing.push(i + 2);
    jisCodeRows.set(jisCode, existing);
  }
  for (const [jisCode, rowNums] of jisCodeRows) {
    if (rowNums.length > 1) {
      errors.push(`jisCode重複: "${jisCode}" 行 ${rowNums.join(", ")}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`バリデーションエラー (${errors.length}件):\n${errors.join("\n")}`);
  }

  return results;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };

  const inputPath  = get("--input")  ?? "data/raw/national/population.csv";
  const outputPath = get("--output") ?? "data/processed/population.json";
  const masterPath = get("--master") ?? "data/master/municipalities-base.json";

  try {
    const results = importPopulationCsv(inputPath, masterPath);
    if (results.length === 0) {
      console.warn(`⚠️  0件: ${inputPath} にデータ行がありません（ヘッダーのみ）`);
      console.warn(`    data/raw/national/population.csv に実データを追加してください`);
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), "utf-8");
    console.log(`OK: ${results.length}件 -> ${outputPath}`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
