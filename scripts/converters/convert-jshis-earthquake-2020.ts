/**
 * J-SHIS 地震ハザード raw JSON を変換し、全1,918市区町村の earthquakeRisk を算出する。
 *
 * 入力:
 *   data/raw/jshis/earthquake-2020.json  (fetch-jshis-earthquake-2020.ts の出力)
 *   src/data/municipalities.json         (市区町村マスター)
 *
 * 出力:
 *   data/processed/earthquake.json       (EarthquakeEntry[])
 *
 * dataStatus 分類:
 *   direct              … J-SHIS から直接取得（earthquakeProbability をそのまま使用）
 *   aggregated-from-wards … 政令市親コードを区コードの単純平均で補完
 *   known-missing       … 北方領土6村・双葉町・浜松市新3区（earthquakeRisk=50固定）
 *   not-found           … J-SHIS にデータなし（earthquakeRisk=50固定）
 *
 * スコア計算:
 *   母集団: direct + aggregated-from-wards
 *   手順: p1/p99 ウィンソライズ → z-score → earthquakeRisk = clamp(round(50-10z), 10, 90)
 *   ※ 確率が高いほどリスクが高く（危険）= スコアが低くなる方向
 *
 * 使い方:
 *   npm run convert:jshis-earthquake-2020
 *   tsx scripts/converters/convert-jshis-earthquake-2020.ts [--input PATH] [--master PATH] [--output PATH]
 */

import fs from "fs";
import path from "path";

// -------------------------------------------------------
// 定数
// -------------------------------------------------------

const DEFAULT_INPUT  = "data/raw/jshis/earthquake-2020.json";
const DEFAULT_MASTER = "src/data/municipalities.json";
const DEFAULT_OUTPUT = "data/processed/earthquake.json";

const SOURCE_URL     = "https://www.j-shis.bosai.go.jp/api-fltsearch-area";
const UPDATED_AT     = "2020-01-01"; // J-SHIS version=Y2020
const CALC_VERSION   = "earthquake-v1" as const;

/**
 * 区コード探索上限。
 * 大阪市（27100）の最大区コードは 27128（+28）。
 * 30 とすることで、隣接する政令市親コード（例: 40130 福岡市）が NOTFOUND で
 * direct に入らないため、次市の区コードへの誤混入を防ぐ。
 */
const WARD_SEARCH_RANGE = 30;

const KNOWN_MISSING = new Set([
  "01695", "01696", "01697", "01698", "01699", "01700", // 北方領土6村
  "07546",                                              // 双葉町
  "22138", "22139", "22140",                           // 浜松市新3区（2024年新設）
]);

// -------------------------------------------------------
// 型定義
// -------------------------------------------------------

type EarthquakeDataStatus =
  | "direct"
  | "aggregated-from-wards"
  | "known-missing"
  | "not-found";

type EarthquakeProbabilityMethod =
  | "direct"
  | "ward-average"
  | "neutral-fallback";

export interface EarthquakeEntry {
  jisCode:                     string;
  prefecture:                  string;
  name:                        string;
  earthquakeRisk:              number;
  earthquakeProbability:       number | null;
  earthquakePex:               number | null;
  earthquakeScore:             number | null;
  earthquakeRank:              number | null;
  earthquakeVersion:           "Y2020";
  earthquakeDataStatus:        EarthquakeDataStatus;
  earthquakeProbabilityMethod: EarthquakeProbabilityMethod;
  earthquakeSourceJisCodes?:   string[];
  earthquakeProbabilityMin?:   number;
  earthquakeProbabilityMax?:   number;
  earthquakeWardCount?:        number;
  earthquakeSource:            string;
  earthquakeUpdatedAt:         string;
  calculationVersion:          typeof CALC_VERSION;
}

interface RawEntry {
  jisCode:               string;
  earthquakeProbability: number | null;
  earthquakePex?:        number | null;
  earthquakeScore?:      number | null;
  earthquakeRank?:       number | null;
}

interface RawJshisOutput {
  entries:  RawEntry[];
  notFound: Array<{ jisCode: string }>;
  failed:   Array<{ jisCode: string }>;
}

interface MasterEntry {
  jisCode?:       string;
  prefecture?:    string;
  municipality?:  string;
}

interface Phase1Entry {
  jisCode:    string;
  prefecture: string;
  name:       string;
  prob:       number | null;
  status:     EarthquakeDataStatus;
  method:     EarthquakeProbabilityMethod;
  rawPex?:    number | null;
  rawScore?:  number | null;
  rawRank?:   number | null;
  wardData?: {
    sourceCodes: string[];
    probs:       number[];
  };
}

// -------------------------------------------------------
// 統計ユーティリティ
// -------------------------------------------------------

function getArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const idx = (p / 100) * (sorted.length - 1);
  const lo  = Math.floor(idx);
  const hi  = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stddev(values: number[], avg: number): number {
  if (values.length <= 1) return 0;
  return Math.sqrt(values.reduce((s, v) => s + (v - avg) ** 2, 0) / values.length);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// -------------------------------------------------------
// メイン変換処理
// -------------------------------------------------------

function convert(inputPath: string, masterPath: string, outputPath: string): void {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`入力ファイルが見つかりません: ${inputPath}`);
  }
  if (!fs.existsSync(masterPath)) {
    throw new Error(`マスターファイルが見つかりません: ${masterPath}`);
  }

  const rawData  = JSON.parse(fs.readFileSync(inputPath,  "utf-8")) as RawJshisOutput;
  const master   = JSON.parse(fs.readFileSync(masterPath, "utf-8")) as MasterEntry[];

  // direct エントリを jisCode で引けるマップ
  const directByCode = new Map<string, RawEntry>(
    rawData.entries.map((e) => [e.jisCode, e]),
  );

  // マスターを jisCode で引けるマップ（区名マッチング用）
  const masterByCode = new Map<string, MasterEntry>(
    master
      .filter((m): m is MasterEntry & { jisCode: string } => typeof m.jisCode === "string")
      .map((m) => [m.jisCode, m]),
  );

  // -------------------------------------------------------
  // Phase 1: 各市区町村の dataStatus と probability を決定
  // -------------------------------------------------------

  const phase1: Phase1Entry[] = [];
  const aggregatedCities: string[] = [];
  const notAggregatedCities: string[] = [];

  for (const muni of master) {
    const jisCode    = muni.jisCode;
    if (typeof jisCode !== "string" || !/^\d{5}$/.test(jisCode)) continue;
    const prefecture = muni.prefecture   ?? "";
    const name       = muni.municipality ?? "";

    // 既知欠損
    if (KNOWN_MISSING.has(jisCode)) {
      phase1.push({ jisCode, prefecture, name, prob: null, status: "known-missing", method: "neutral-fallback" });
      continue;
    }

    // direct 取得済み
    if (directByCode.has(jisCode)) {
      const entry = directByCode.get(jisCode)!;
      phase1.push({
        jisCode, prefecture, name,
        prob:     entry.earthquakeProbability,
        status:   "direct",
        method:   "direct",
        rawPex:   entry.earthquakePex   ?? null,
        rawScore: entry.earthquakeScore ?? null,
        rawRank:  entry.earthquakeRank  ?? null,
      });
      continue;
    }

    // 政令市親コード → 区コード単純平均で補完を試みる。
    // 区コード候補はマスター上で「親の市名から始まる名称」を持つものに限定する。
    // 例: 親"札幌市" → 区"札幌市中央区" (OK) / 親"小樽市" → 候補"旭川市" (NG)
    // これにより、隣接する別自治体を誤って"区"とみなすことを防ぐ。
    const base       = parseInt(jisCode, 10);
    const wardPairs: Array<{ code: string; prob: number | null }> = [];
    for (let i = 1; i <= WARD_SEARCH_RANGE; i++) {
      const wardCode = String(base + i).padStart(5, "0");
      if (directByCode.has(wardCode)) {
        const wardMuni = masterByCode.get(wardCode);
        const wardName = wardMuni?.municipality ?? "";
        // 区コードの自治体名が親の市名から始まる場合のみ採用（政令市ガード）
        if (name.length > 0 && wardName.startsWith(name)) {
          wardPairs.push({ code: wardCode, prob: directByCode.get(wardCode)!.earthquakeProbability });
        }
      }
    }

    if (wardPairs.length > 0) {
      const validProbs = wardPairs.map((w) => w.prob).filter((p): p is number => p !== null);
      if (validProbs.length > 0) {
        const avgProb = mean(validProbs);
        aggregatedCities.push(`${jisCode} ${prefecture} ${name} (区数=${wardPairs.length})`);
        phase1.push({
          jisCode, prefecture, name,
          prob:   avgProb,
          status: "aggregated-from-wards",
          method: "ward-average",
          wardData: {
            sourceCodes: wardPairs.map((w) => w.code),
            probs:       validProbs,
          },
        });
      } else {
        // 区コードは見つかったが全て prob=null → not-found 扱い
        notAggregatedCities.push(`${jisCode} ${prefecture} ${name} (全区prob=null)`);
        phase1.push({ jisCode, prefecture, name, prob: null, status: "not-found", method: "neutral-fallback" });
      }
    } else {
      // 区コードなし → not-found
      phase1.push({ jisCode, prefecture, name, prob: null, status: "not-found", method: "neutral-fallback" });
      // 浜松市 22130 を明示追跡
      if (jisCode === "22130") {
        notAggregatedCities.push(`${jisCode} ${prefecture} ${name} (区コードなし→not-found)`);
      }
    }
  }

  // -------------------------------------------------------
  // Phase 2: z-score 計算（母集団: direct + aggregated-from-wards）
  // -------------------------------------------------------

  const population = phase1.filter(
    (e): e is Phase1Entry & { prob: number } =>
      (e.status === "direct" || e.status === "aggregated-from-wards") && e.prob !== null,
  );
  const probValues = population.map((e) => e.prob);

  const earthquakeRiskByCode = new Map<string, number>();

  if (probValues.length >= 2) {
    const sorted = [...probValues].sort((a, b) => a - b);
    const p1Val  = percentile(sorted, 1);
    const p99Val = percentile(sorted, 99);

    const winsorized = probValues.map((v) => clamp(v, p1Val, p99Val));
    const avg = mean(winsorized);
    const sd  = stddev(winsorized, avg);

    population.forEach((e, i) => {
      const z    = sd === 0 ? 0 : (winsorized[i]! - avg) / sd;
      const risk = clamp(Math.round(50 - 10 * z), 10, 90);
      earthquakeRiskByCode.set(e.jisCode, risk);
    });
  }

  // -------------------------------------------------------
  // Phase 3: EarthquakeEntry 構築
  // -------------------------------------------------------

  const results: EarthquakeEntry[] = phase1.map((e) => {
    const isScored = e.status === "direct" || e.status === "aggregated-from-wards";
    const earthquakeRisk = isScored
      ? (earthquakeRiskByCode.get(e.jisCode) ?? 50)
      : 50;

    const isDirect = e.status === "direct";
    const entry: EarthquakeEntry = {
      jisCode:                     e.jisCode,
      prefecture:                  e.prefecture,
      name:                        e.name,
      earthquakeRisk,
      earthquakeProbability:       e.prob,
      earthquakePex:               isDirect ? (e.rawPex   ?? null) : null,
      earthquakeScore:             isDirect ? (e.rawScore ?? null) : null,
      earthquakeRank:              isDirect ? (e.rawRank  ?? null) : null,
      earthquakeVersion:           "Y2020",
      earthquakeDataStatus:        e.status,
      earthquakeProbabilityMethod: e.method,
      earthquakeSource:            SOURCE_URL,
      earthquakeUpdatedAt:         UPDATED_AT,
      calculationVersion:          CALC_VERSION,
    };

    if (e.wardData) {
      entry.earthquakeSourceJisCodes = e.wardData.sourceCodes;
      entry.earthquakeProbabilityMin = Math.min(...e.wardData.probs);
      entry.earthquakeProbabilityMax = Math.max(...e.wardData.probs);
      entry.earthquakeWardCount      = e.wardData.sourceCodes.length;
    }

    return entry;
  });

  // -------------------------------------------------------
  // 出力
  // -------------------------------------------------------

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), "utf-8");

  const sizeKb = (fs.statSync(outputPath).size / 1024).toFixed(1);

  // -------------------------------------------------------
  // ログ出力
  // -------------------------------------------------------

  const directCount      = results.filter((e) => e.earthquakeDataStatus === "direct").length;
  const aggregatedCount  = results.filter((e) => e.earthquakeDataStatus === "aggregated-from-wards").length;
  const knownMissingCount = results.filter((e) => e.earthquakeDataStatus === "known-missing").length;
  const notFoundCount    = results.filter((e) => e.earthquakeDataStatus === "not-found").length;

  const scoredProbs  = results
    .filter((e) => e.earthquakeDataStatus === "direct" || e.earthquakeDataStatus === "aggregated-from-wards")
    .map((e) => e.earthquakeProbability)
    .filter((v): v is number => v !== null);
  const risks = results
    .filter((e) => e.earthquakeDataStatus === "direct" || e.earthquakeDataStatus === "aggregated-from-wards")
    .map((e) => e.earthquakeRisk);

  const probMin = scoredProbs.length ? Math.min(...scoredProbs) : null;
  const probMax = scoredProbs.length ? Math.max(...scoredProbs) : null;
  const riskMin = risks.length ? Math.min(...risks) : null;
  const riskMax = risks.length ? Math.max(...risks) : null;

  const hamamatsu = results.find((e) => e.jisCode === "22130");

  console.log(`\n========================================`);
  console.log(`convert-jshis-earthquake-2020 完了レポート`);
  console.log(`========================================`);
  console.log(`total                   : ${results.length}`);
  console.log(`direct                  : ${directCount}`);
  console.log(`aggregated-from-wards   : ${aggregatedCount}`);
  console.log(`known-missing           : ${knownMissingCount}`);
  console.log(`not-found               : ${notFoundCount}`);
  console.log(`scorePopulationCount    : ${population.length}`);
  console.log(`\nprobability min/max     : ${probMin?.toFixed(5) ?? "—"} 〜 ${probMax?.toFixed(5) ?? "—"}`);
  console.log(`earthquakeRisk min/max  : ${riskMin ?? "—"} 〜 ${riskMax ?? "—"}`);

  console.log(`\n--- 政令市親コード補完 (${aggregatedCities.length}件) ---`);
  aggregatedCities.forEach((s) => console.log(`  補完: ${s}`));
  if (notAggregatedCities.length > 0) {
    console.log(`\n--- 補完できなかった政令市親コード (${notAggregatedCities.length}件) ---`);
    notAggregatedCities.forEach((s) => console.log(`  未補完: ${s}`));
  }

  console.log(`\n--- 浜松市22130の扱い ---`);
  if (hamamatsu) {
    console.log(`  jisCode           : ${hamamatsu.jisCode}`);
    console.log(`  earthquakeDataStatus : ${hamamatsu.earthquakeDataStatus}`);
    console.log(`  earthquakeRisk    : ${hamamatsu.earthquakeRisk}`);
    console.log(`  earthquakeProbability: ${hamamatsu.earthquakeProbability ?? "null"}`);
  } else {
    console.log(`  22130 はマスターに存在しない`);
  }

  console.log(`\n--- 出力 ---`);
  console.log(`パス  : ${outputPath} (${sizeKb} KB)`);

  console.log(`\n--- direct サンプル (先頭3件) ---`);
  results.filter((e) => e.earthquakeDataStatus === "direct").slice(0, 3).forEach((e) => {
    console.log(
      `  [${e.jisCode}] ${e.prefecture} ${e.name}` +
      ` | prob=${e.earthquakeProbability?.toFixed(5) ?? "null"}` +
      ` | pex=${e.earthquakePex ?? "null"}` +
      ` | score=${e.earthquakeScore?.toExponential(3) ?? "null"}` +
      ` | rank=${e.earthquakeRank ?? "null"}` +
      ` | ver=${e.earthquakeVersion}` +
      ` | risk=${e.earthquakeRisk}`,
    );
  });

  console.log(`\n--- aggregated-from-wards サンプル (先頭3件) ---`);
  results.filter((e) => e.earthquakeDataStatus === "aggregated-from-wards").slice(0, 3).forEach((e) => {
    console.log(
      `  [${e.jisCode}] ${e.prefecture} ${e.name}` +
      ` | avgProb=${e.earthquakeProbability?.toFixed(5) ?? "null"}` +
      ` | risk=${e.earthquakeRisk}` +
      ` | wards=${e.earthquakeWardCount}` +
      ` [${e.earthquakeProbabilityMin?.toFixed(5)}〜${e.earthquakeProbabilityMax?.toFixed(5)}]`,
    );
  });

  console.log(`\n次のステップ:`);
  console.log(`  npm run import:earthquake`);
  console.log(`  npm run score:earthquake-v1 -- --output data/processed/earthquake.json`);
}

// -------------------------------------------------------
// CLI エントリポイント
// -------------------------------------------------------

if (require.main === module) {
  const inputPath  = getArg("--input")  ?? DEFAULT_INPUT;
  const masterPath = getArg("--master") ?? DEFAULT_MASTER;
  const outputPath = getArg("--output") ?? DEFAULT_OUTPUT;

  try {
    convert(inputPath, masterPath, outputPath);
  } catch (e) {
    console.error(`\nERROR: ${(e as Error).message}`);
    process.exit(1);
  }
}
