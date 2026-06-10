/**
 * J-SHIS API を使って全市区町村の地震ハザード指標を取得する。
 *
 * データソース:
 *   防災科研 地震ハザードステーション（J-SHIS）
 *   条件付き超過確率 API (fltsearch)
 *   version=Y2020, period=P_T30, ijma=55, param=-1, case=MAX
 *
 * 指標の意味:
 *   earthquakeProbability = 震度6弱以上・30年以内・最大ケースの超過確率（Fault[0].probability）
 *     → J-SHIS の「指定震度・30年・最大ケース・param=-1 条件」下のハザード代理指標。
 *       「純粋な地震発生確率」ではなく、param=-1（確率重視）設定での確率優先ソートによる
 *       最上位断層の超過確率。
 *   earthquakePex   = 参考: 震度曝露人口（人口要素を含むため主指標に使わない）
 *   earthquakeScore = 参考: 一般化リスク指数（prob^0.4 × pex^1.6、社会リスク複合指標）
 *
 * 404 の扱い:
 *   J-SHIS にエリアデータが存在しない自治体（政令市親コード・離島・低地震域等）は
 *   failed ではなく notFound として記録する。
 *
 * 入力:
 *   src/data/municipalities.json
 *
 * 出力:
 *   data/raw/jshis/earthquake-2020.json
 *
 * 使い方:
 *   npm run fetch:jshis-earthquake-2020                  # 全件取得
 *   npm run fetch:jshis-earthquake-2020 -- --retry-failed  # failed 再取得
 *   tsx scripts/fetchers/fetch-jshis-earthquake-2020.ts [--input PATH] [--output PATH] [--retry-failed]
 */

import fs from "fs";
import path from "path";

// -------------------------------------------------------
// 定数
// -------------------------------------------------------

const API_ENDPOINT = "https://www.j-shis.bosai.go.jp/map/api/fltsearch";
const SOURCE_URL   = "https://www.j-shis.bosai.go.jp/api-fltsearch-area";
const DEFAULT_INPUT  = "src/data/municipalities.json";
const DEFAULT_OUTPUT = "data/raw/jshis/earthquake-2020.json";

const API_PARAMS = {
  ecode:   "ALL_NT_A",
  mode:    "C",
  version: "Y2020",
  case:    "MAX",
  period:  "P_T30",
  ijma:    "55",
  param:   "-1",
  format:  "json",
} as const;

const DELAY_MIN_MS = 100;
const DELAY_MAX_MS = 200;
const RETRY_MAX    = 3;
const RETRY_DELAYS = [1000, 2000, 4000]; // ms
const LOG_INTERVAL = 50;

// -------------------------------------------------------
// 型定義
// -------------------------------------------------------

interface Municipality {
  jisCode:       string;
  prefecture?:   string;
  municipality?: string;
}

interface EntryMetaData {
  areacode: string;
  version:  string;
  case:     string;
  period:   string;
  ijma:     string | null;
  param:    string | null;
}

interface DirectEntry {
  jisCode:               string;
  prefecture:            string;
  name:                  string;
  dataStatus:            "direct";
  earthquakeProbability: number | null;
  earthquakePex:         number | null;
  earthquakeScore:       number | null;
  earthquakeRank:        number | null;
  metaData:              EntryMetaData;
}

interface NotFoundEntry {
  jisCode:    string;
  prefecture: string;
  name:       string;
  dataStatus: "not-found";
  httpStatus: 404;
  reason:     string;
}

interface FailedEntry {
  jisCode:      string;
  prefecture:   string;
  name:         string;
  reason:       string;
  statusCode?:  number;
  attempts:     number;
  lastTriedAt?: string;
  requestUrl?:  string;
}

interface JshisOutput {
  fetchedAt:      string;
  sourceUrl:      string;
  apiParams:      typeof API_PARAMS;
  totalRequested: number;
  successCount:   number;
  notFoundCount:  number;
  failedCount:    number;
  skippedCount:   number;
  entries:        DirectEntry[];
  notFound:       NotFoundEntry[];
  failed:         FailedEntry[];
  skipped:        string[];
}

// -------------------------------------------------------
// ユーティリティ
// -------------------------------------------------------

function getArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(): Promise<void> {
  const ms = DELAY_MIN_MS + Math.floor(Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS + 1));
  return sleep(ms);
}

function buildRequestUrl(jisCode: string): string {
  const params = new URLSearchParams({ ...API_PARAMS, areacode: `A${jisCode}` });
  return `${API_ENDPOINT}?${params.toString()}`;
}

/** 403/429/5xx は rate-limit 系として retry 対象。404 は即座に notFound 扱い。 */
function isRetryable(status: number): boolean {
  return status === 403 || status === 429 || status >= 500;
}

function probStats(entries: DirectEntry[]): { min: number | null; max: number | null } {
  const vals = entries.map((e) => e.earthquakeProbability).filter((v): v is number => v !== null);
  return { min: vals.length ? Math.min(...vals) : null, max: vals.length ? Math.max(...vals) : null };
}

// -------------------------------------------------------
// J-SHIS API 1件取得
// -------------------------------------------------------

interface RawFaultItem {
  rank?:        string | number;
  probability?: string | number;
  score?:       string | number;
  pex?:         string | number;
  Pattern?:     Array<{ pex?: string | number; [k: string]: unknown }>;
  [k: string]:  unknown;
}

interface RawJshisResponse {
  metaData?: Record<string, string | number | null | undefined>;
  Fault?:    RawFaultItem[];
  [k: string]: unknown;
}

type FetchResult =
  | { kind: "direct";    entry: DirectEntry }
  | { kind: "not-found"; entry: NotFoundEntry }
  | { kind: "failed";    entry: FailedEntry };

async function fetchOne(
  jisCode:    string,
  prefecture: string,
  name:       string,
): Promise<FetchResult> {
  const requestUrl = buildRequestUrl(jisCode);
  let lastError    = "";
  let lastStatus: number | undefined;

  for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
    try {
      const resp = await fetch(requestUrl);

      // 404 → notFound（retry しない）
      if (resp.status === 404) {
        return {
          kind: "not-found",
          entry: {
            jisCode, prefecture, name,
            dataStatus: "not-found",
            httpStatus: 404,
            reason: "J-SHIS API returned 404: no matching data",
          },
        };
      }

      // 403/429/5xx → retry
      if (!resp.ok) {
        lastStatus = resp.status;
        lastError  = `HTTP ${resp.status} ${resp.statusText}`;
        if (isRetryable(resp.status) && attempt < RETRY_MAX) {
          await sleep(RETRY_DELAYS[attempt - 1] ?? 4000);
          continue;
        }
        break;
      }

      const body   = await resp.json() as RawJshisResponse;
      const meta   = body.metaData ?? {};
      const faults = body.Fault;

      const metaData: EntryMetaData = {
        areacode: meta["areacode"] != null ? String(meta["areacode"]) : `A${jisCode}`,
        version:  meta["version"]  != null ? String(meta["version"])  : API_PARAMS.version,
        case:     meta["case"]     != null ? String(meta["case"])     : API_PARAMS.case,
        period:   meta["period"]   != null ? String(meta["period"])   : API_PARAMS.period,
        ijma:     meta["ijma"]     != null ? String(meta["ijma"])     : null,
        param:    meta["param"]    != null ? String(meta["param"])    : null,
      };

      if (!faults || faults.length === 0) {
        return {
          kind: "direct",
          entry: {
            jisCode, prefecture, name,
            dataStatus:            "direct",
            earthquakeProbability: null,
            earthquakePex:         null,
            earthquakeScore:       null,
            earthquakeRank:        null,
            metaData,
          },
        };
      }

      const fault0 = faults[0]!;
      const pexRaw = fault0["pex"] != null
        ? fault0["pex"]
        : (fault0["Pattern"]?.[0]?.["pex"] ?? null);

      const probability = fault0["probability"] != null ? parseFloat(String(fault0["probability"])) : null;
      const pex         = pexRaw != null               ? parseFloat(String(pexRaw))                : null;
      const score       = fault0["score"] != null       ? parseFloat(String(fault0["score"]))       : null;
      const rankRaw     = fault0["rank"]  != null       ? parseInt(String(fault0["rank"]), 10)      : null;
      const rank        = rankRaw != null && !isNaN(rankRaw) ? rankRaw : null;

      return {
        kind: "direct",
        entry: {
          jisCode, prefecture, name,
          dataStatus:            "direct",
          earthquakeProbability: probability,
          earthquakePex:         pex,
          earthquakeScore:       score,
          earthquakeRank:        rank,
          metaData,
        },
      };
    } catch (e) {
      lastError = (e as Error).message;
      if (attempt < RETRY_MAX) {
        await sleep(RETRY_DELAYS[attempt - 1] ?? 4000);
      }
    }
  }

  return {
    kind: "failed",
    entry: {
      jisCode, prefecture, name,
      reason:      lastError || "fetch failed",
      statusCode:  lastStatus,
      attempts:    RETRY_MAX,
      lastTriedAt: new Date().toISOString(),
      requestUrl,
    },
  };
}

// -------------------------------------------------------
// モード A: 全件取得
// -------------------------------------------------------

async function fetchAll(inputPath: string, outputPath: string): Promise<void> {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`入力ファイルが見つかりません: ${inputPath}`);
  }

  const municipalities = JSON.parse(
    fs.readFileSync(inputPath, "utf-8"),
  ) as Municipality[];

  const targets = municipalities.filter(
    (m): m is Municipality & { jisCode: string } =>
      typeof m.jisCode === "string" && /^\d{5}$/.test(m.jisCode),
  );

  console.log(`\n--- J-SHIS 地震ハザード取得開始（全件）---`);
  console.log(`対象市区町村数  : ${targets.length.toLocaleString()} 件`);
  console.log(`パラメータ      : ijma=55, param=-1, period=P_T30, case=MAX, version=Y2020`);
  console.log(`推定所要時間    : 約 ${Math.ceil(targets.length * 0.15 / 60)} 分\n`);

  const entries:  DirectEntry[]   = [];
  const notFound: NotFoundEntry[] = [];
  const failed:   FailedEntry[]   = [];
  const skipped:  string[]        = [];
  const startTime = Date.now();

  for (let i = 0; i < targets.length; i++) {
    const m          = targets[i]!;
    const jisCode    = m.jisCode;
    const prefecture = m.prefecture   ?? "";
    const name       = m.municipality ?? "";

    if (i > 0 && i % LOG_INTERVAL === 0) {
      const elapsed   = (Date.now() - startTime) / 1000;
      const rate      = i / elapsed;
      const remaining = (targets.length - i) / rate;
      console.log(
        `[${String(i).padStart(4)}/${targets.length}]` +
        ` direct=${entries.length} notFound=${notFound.length} failed=${failed.length}` +
        ` 残り約${Math.ceil(remaining)}秒`,
      );
    }

    const result = await fetchOne(jisCode, prefecture, name);

    if (result.kind === "direct") {
      entries.push(result.entry);
    } else if (result.kind === "not-found") {
      notFound.push(result.entry);
      console.log(`  NOT-FOUND [${jisCode}] ${prefecture} ${name}`);
    } else {
      failed.push(result.entry);
      console.warn(`  FAILED    [${jisCode}] ${prefecture} ${name} — ${result.entry.reason}`);
    }

    await randomDelay();
  }

  const output = buildOutput(targets.length, entries, notFound, failed, skipped);
  writeOutput(outputPath, output);
  printFinalReport(output, (Date.now() - startTime) / 1000);
}

// -------------------------------------------------------
// モード B: failed 再取得 (--retry-failed)
// -------------------------------------------------------

async function retryFailed(outputPath: string): Promise<void> {
  if (!fs.existsSync(outputPath)) {
    throw new Error(
      `出力ファイルが見つかりません: ${outputPath}\n` +
      `先に npm run fetch:jshis-earthquake-2020 を実行してください。`,
    );
  }

  const data = JSON.parse(fs.readFileSync(outputPath, "utf-8")) as JshisOutput;

  const retryTargets = data.failed;
  if (retryTargets.length === 0) {
    console.log(`\nfailed エントリが 0 件です。再取得不要。`);
    return;
  }

  console.log(`\n--- J-SHIS failed 再取得 ---`);
  console.log(`再取得対象   : ${retryTargets.length} 件`);
  console.log(`パラメータ   : ijma=55, param=-1, period=P_T30, case=MAX, version=Y2020\n`);

  let retrySuccessCount  = 0;
  let retryNotFoundCount = 0;
  let retryStillFailed   = 0;

  const newDirectEntries:   DirectEntry[]   = [];
  const newNotFoundEntries: NotFoundEntry[] = [];
  const remainingFailed:    FailedEntry[]   = [];

  for (const target of retryTargets) {
    console.log(`  RETRY [${target.jisCode}] ${target.prefecture} ${target.name}`);

    const result = await fetchOne(target.jisCode, target.prefecture, target.name);

    if (result.kind === "direct") {
      newDirectEntries.push(result.entry);
      retrySuccessCount++;
      console.log(`    → DIRECT ✅ prob=${result.entry.earthquakeProbability?.toFixed(5) ?? "null"}`);
    } else if (result.kind === "not-found") {
      newNotFoundEntries.push(result.entry);
      retryNotFoundCount++;
      console.log(`    → NOT-FOUND (404)`);
    } else {
      // 再取得失敗: attempts を累計し lastTriedAt / requestUrl を更新
      remainingFailed.push({
        ...result.entry,
        reason:      result.entry.reason === "fetch failed"
          ? "retry-exhausted: fetch failed"
          : result.entry.reason,
        attempts:    (target.attempts ?? 0) + result.entry.attempts,
        lastTriedAt: result.entry.lastTriedAt,
        requestUrl:  result.entry.requestUrl,
      });
      retryStillFailed++;
      console.warn(`    → STILL FAILED — ${result.entry.reason}`);
    }

    await randomDelay();
  }

  // データを更新してファイルに書き戻す
  data.entries  = [...data.entries,  ...newDirectEntries];
  data.notFound = [...data.notFound, ...newNotFoundEntries];
  data.failed   = remainingFailed;

  data.successCount  = data.entries.length;
  data.notFoundCount = data.notFound.length;
  data.failedCount   = data.failed.length;
  data.fetchedAt     = new Date().toISOString();

  writeOutput(outputPath, data);

  const { min: probMin, max: probMax } = probStats(data.entries);

  // -------------------------------------------------------
  // retry 完了レポート
  // -------------------------------------------------------
  console.log(`\n========================================`);
  console.log(`J-SHIS failed 再取得 完了レポート`);
  console.log(`========================================`);
  console.log(`retryTargetCount    : ${retryTargets.length} 件`);
  console.log(`retrySuccessCount   : ${retrySuccessCount} 件 (→ entries に追加)`);
  console.log(`retryNotFoundCount  : ${retryNotFoundCount} 件 (→ notFound に移動)`);
  console.log(`retryStillFailedCount: ${retryStillFailed} 件 (→ failed に残留)`);
  console.log(``);
  console.log(`--- 更新後の全体集計 ---`);
  console.log(`total               : ${data.totalRequested} 件`);
  console.log(`direct              : ${data.successCount} 件`);
  console.log(`notFound            : ${data.notFoundCount} 件`);
  console.log(`failed              : ${data.failedCount} 件`);
  console.log(`skipped             : ${data.skippedCount} 件`);
  console.log(`403/429/5xx発生     : ${remainingFailed.filter((f) => f.statusCode && isRetryable(f.statusCode)).length} 件`);
  console.log(`probability range   : ${probMin?.toFixed(5) ?? "—"} 〜 ${probMax?.toFixed(5) ?? "—"}`);

  if (remainingFailed.length > 0) {
    console.log(`\n--- failedRemaining JIS一覧 ---`);
    remainingFailed.forEach((f) => {
      console.log(`  [${f.jisCode}] ${f.prefecture} ${f.name} — ${f.reason}`);
    });
  } else {
    console.log(`\nfailed = 0 ✅ 全件解決`);
  }

  const sizeKb = (fs.statSync(outputPath).size / 1024).toFixed(1);
  console.log(`\n出力ファイル : ${outputPath} (${sizeKb} KB) ✅`);
}

// -------------------------------------------------------
// 共通ユーティリティ
// -------------------------------------------------------

function buildOutput(
  totalRequested: number,
  entries:        DirectEntry[],
  notFound:       NotFoundEntry[],
  failed:         FailedEntry[],
  skipped:        string[],
): JshisOutput {
  return {
    fetchedAt:      new Date().toISOString(),
    sourceUrl:      SOURCE_URL,
    apiParams:      API_PARAMS,
    totalRequested,
    successCount:   entries.length,
    notFoundCount:  notFound.length,
    failedCount:    failed.length,
    skippedCount:   skipped.length,
    entries,
    notFound,
    failed,
    skipped,
  };
}

function writeOutput(outputPath: string, output: JshisOutput): void {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf-8");
}

function printFinalReport(output: JshisOutput, elapsedSec: number): void {
  const { min: probMin, max: probMax } = probStats(output.entries);
  const pexs   = output.entries.map((e) => e.earthquakePex).filter((v): v is number => v !== null);
  const scores = output.entries.map((e) => e.earthquakeScore).filter((v): v is number => v !== null);

  const sizeKb = (fs.statSync(DEFAULT_OUTPUT).size / 1024).toFixed(1);

  console.log(`\n========================================`);
  console.log(`J-SHIS 地震ハザード取得 完了レポート`);
  console.log(`========================================`);
  console.log(`取得対象件数    : ${output.totalRequested.toLocaleString()} 件`);
  console.log(`success件数     : ${output.successCount.toLocaleString()} 件`);
  console.log(`notFound件数    : ${output.notFoundCount} 件`);
  console.log(`failed件数      : ${output.failedCount} 件`);
  console.log(`skipped件数     : ${output.skippedCount} 件`);
  console.log(`403/429/5xx発生 : ${output.failed.filter((f) => f.statusCode && isRetryable(f.statusCode)).length} 件`);
  console.log(`\nprobability range : ${probMin?.toFixed(5) ?? "—"} 〜 ${probMax?.toFixed(5) ?? "—"}`);
  console.log(`pex range         : ${pexs.length ? Math.min(...pexs).toLocaleString() : "—"} 〜 ${pexs.length ? Math.max(...pexs).toLocaleString() : "—"}`);
  console.log(`score range       : ${scores.length ? Math.min(...scores).toExponential(3) : "—"} 〜 ${scores.length ? Math.max(...scores).toExponential(3) : "—"}`);
  console.log(`\nijma   : ${API_PARAMS.ijma}  ✅`);
  console.log(`param  : ${API_PARAMS.param} ✅`);
  console.log(`\n出力   : ${DEFAULT_OUTPUT} (${sizeKb} KB)`);
  console.log(`所要時間: ${elapsedSec.toFixed(1)} 秒`);

  if (output.entries.length >= 3) {
    console.log(`\n--- direct サンプル（先頭3件）---`);
    output.entries.slice(0, 3).forEach((e) => {
      console.log(
        `  [${e.jisCode}] ${e.prefecture} ${e.name}` +
        ` | prob=${e.earthquakeProbability?.toFixed(5) ?? "null"}` +
        ` | pex=${e.earthquakePex?.toLocaleString() ?? "null"}` +
        ` | score=${e.earthquakeScore?.toExponential(3) ?? "null"}` +
        ` | rank=${e.earthquakeRank ?? "null"}`,
      );
    });
  }

  if (output.notFound.length > 0) {
    console.log(`\n--- notFound サンプル（先頭5件）---`);
    output.notFound.slice(0, 5).forEach((e) => {
      console.log(`  [${e.jisCode}] ${e.prefecture} ${e.name}`);
    });
    if (output.notFound.length > 5) console.log(`  ... 他 ${output.notFound.length - 5} 件`);
  }

  if (output.failed.length > 0) {
    console.log(`\n--- failed 詳細 ---`);
    output.failed.forEach((f) => {
      console.log(`  [${f.jisCode}] ${f.prefecture} ${f.name} — ${f.reason}`);
    });
  }
}

// -------------------------------------------------------
// CLI エントリポイント
// -------------------------------------------------------

if (require.main === module) {
  const outputPath   = getArg("--output") ?? DEFAULT_OUTPUT;
  const isRetryMode  = hasFlag("--retry-failed");

  if (isRetryMode) {
    retryFailed(outputPath).catch((e) => {
      console.error(`\nERROR: ${(e as Error).message}`);
      process.exit(1);
    });
  } else {
    const inputPath = getArg("--input") ?? DEFAULT_INPUT;
    fetchAll(inputPath, outputPath).catch((e) => {
      console.error(`\nERROR: ${(e as Error).message}`);
      process.exit(1);
    });
  }
}
