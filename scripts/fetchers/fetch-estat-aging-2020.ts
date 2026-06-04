/**
 * e-Stat API v3.0 を使って令和2年国勢調査 表2-7-1 の CSV を全ページ取得する。
 *
 * 統計表: 令和２年国勢調査 人口等基本集計
 *   statsDataId: 0003445162
 *   表2-7-1: 男女，年齢（5歳階級），国籍総数か日本人別人口－全国，都道府県，市区町村
 *
 * ページング:
 *   e-Stat API は1リクエスト最大100,000行。NEXT_KEY がある限りループし全行取得する。
 *   1ページ目はメタデータブロック込みで保存し、2ページ目以降はそのまま連結する。
 *   converter (readEstatCsv) はメタデータ行を自動スキップするため連結形式で問題ない。
 *
 * 使い方:
 *   npm run fetch:estat-aging-2020
 *   tsx scripts/fetchers/fetch-estat-aging-2020.ts [--output PATH]
 *
 * 出力:
 *   data/raw/estat/aging-2020.csv
 */

import fs from "fs";
import path from "path";

const STATS_DATA_ID  = "0003445162";
const DEFAULT_OUTPUT = "data/raw/estat/aging-2020.csv";
const MAX_PAGES      = 20; // 無限ループ防止

const API_BASE =
  "https://api.e-stat.go.jp/rest/3.0/app/getSimpleStatsData";

// -------------------------------------------------------
// ユーティリティ
// -------------------------------------------------------

function getArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function loadEnvLocal(): void {
  const envPath = path.resolve(".env.local");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !(key in process.env)) {
      process.env[key] = val;
    }
  }
}

/**
 * メタデータブロックの値を取得する。
 * e-Stat CSV のメタデータ行は `"KEY","VALUE"` 形式（先頭30行以内）。
 */
function extractMetaValue(csvText: string, key: string): string | null {
  const lines = csvText.split("\n").slice(0, 30);
  for (const line of lines) {
    const match = line.trim().match(/^"([^"]+)","([^"]+)"/);
    if (match && match[1] === key) return match[2] ?? null;
  }
  return null;
}

// -------------------------------------------------------
// メイン
// -------------------------------------------------------

async function fetchEstatAging(outputPath: string): Promise<void> {
  loadEnvLocal();

  const appId = process.env["ESTAT_APP_ID"];
  if (!appId) {
    throw new Error(
      `ESTAT_APP_ID が設定されていません。\n\n` +
      `【設定手順】\n` +
      `  1. https://www.e-stat.go.jp/mypage/user/preregister でアカウント登録（無料）\n` +
      `  2. マイページ → アプリケーションID を発行\n` +
      `  3. プロジェクトルートに .env.local を作成し、以下を記載:\n` +
      `       ESTAT_APP_ID=your_app_id_here\n` +
      `  4. 再度このコマンドを実行: npm run fetch:estat-aging-2020`,
    );
  }

  const safeBase = `${API_BASE}?statsDataId=${STATS_DATA_ID}&downloadKind=1&...`;
  console.log(`e-Stat API リクエスト開始: ${safeBase}`);
  console.log(`statsDataId: ${STATS_DATA_ID}`);
  console.log(`表: 令和2年国勢調査 表2-7-1（男女・年齢5歳階級・市区町村別人口）\n`);

  const chunks: string[] = [];
  let nextKey: string | null = null;
  let page = 0;
  let totalNumber: number | null = null;

  while (true) {
    page++;
    if (page > MAX_PAGES) {
      throw new Error(`ページ上限 (${MAX_PAGES}) に達しました。NEXT_KEY: ${nextKey}`);
    }

    const params = new URLSearchParams({
      appId:            appId,
      statsDataId:      STATS_DATA_ID,
      downloadKind:     "1",
      sectionHeaderFlg: "1",
      metaGetFlg:       "N",
      cntGetFlg:        "N",
    });
    if (nextKey !== null) {
      params.set("startPosition", nextKey);
    }
    const url = `${API_BASE}?${params.toString()}`;

    const startPosition = nextKey ?? "1";
    console.log(`[ページ ${page}] startPosition=${startPosition} 取得中...`);

    let resp: Response;
    try {
      resp = await fetch(url);
    } catch (e) {
      throw new Error(`[ページ ${page} / startPosition=${startPosition}] HTTP リクエスト失敗: ${(e as Error).message}`);
    }

    if (!resp.ok) {
      throw new Error(
        `[ページ ${page} / startPosition=${startPosition}] HTTP エラー: ${resp.status} ${resp.statusText}`,
      );
    }

    const contentType = resp.headers.get("content-type") ?? "";
    if (contentType.includes("json")) {
      const body = await resp.json() as Record<string, unknown>;
      throw new Error(
        `[ページ ${page} / startPosition=${startPosition}] e-Stat API エラー:\n` +
        `  ${JSON.stringify(body, null, 2)}\n` +
        `  ESTAT_APP_ID が正しいか確認してください。`,
      );
    }

    const csvText = await resp.text();
    if (!csvText || csvText.trim().length === 0) {
      throw new Error(`[ページ ${page} / startPosition=${startPosition}] レスポンスが空です`);
    }

    // メタデータを抽出してログ出力（appId は含まない）
    const pageTotalNumber = extractMetaValue(csvText, "TOTAL_NUMBER");
    const pageFromNumber  = extractMetaValue(csvText, "FROM_NUMBER");
    const pageToNumber    = extractMetaValue(csvText, "TO_NUMBER");
    const pageNextKey     = extractMetaValue(csvText, "NEXT_KEY");

    if (page === 1 && pageTotalNumber) {
      totalNumber = parseInt(pageTotalNumber, 10);
    }

    const dataLines = csvText.split("\n").length;
    console.log(`  TOTAL_NUMBER  : ${pageTotalNumber ?? "—"}`);
    console.log(`  FROM_NUMBER   : ${pageFromNumber ?? "—"}`);
    console.log(`  TO_NUMBER     : ${pageToNumber ?? "—"}`);
    console.log(`  NEXT_KEY      : ${pageNextKey ?? "（なし、最終ページ）"}`);
    console.log(`  取得行数      : ${dataLines} 行`);

    chunks.push(csvText);

    if (!pageNextKey) {
      console.log(`\n最終ページに到達しました（ページ ${page}）`);
      break;
    }
    nextKey = pageNextKey;
  }

  // 全ページを連結して保存
  // 2ページ目以降のメタデータ行は converter (readEstatCsv) がスキップするため
  // 単純連結で問題ない（無効な地域コードとして自動除外される）
  const combined = chunks.join("\n");

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, combined, "utf-8");

  const totalLines = combined.split("\n").length;
  const sizeKb     = (Buffer.byteLength(combined, "utf-8") / 1024).toFixed(1);

  console.log(`\n✅ 保存完了: ${outputPath}`);
  console.log(`   総ページ数    : ${page} ページ`);
  console.log(`   TOTAL_NUMBER  : ${totalNumber?.toLocaleString() ?? "—"}`);
  console.log(`   ファイルサイズ: ${sizeKb} KB`);
  console.log(`   総行数        : ${totalLines.toLocaleString()} 行`);

  console.log(`\n先頭20行プレビュー:`);
  combined.split("\n").slice(0, 20).forEach((l, i) =>
    console.log(`  [${String(i + 1).padStart(2)}] ${l.slice(0, 120)}`),
  );

  console.log(`\n末尾20行プレビュー:`);
  const allLines = combined.split("\n");
  allLines.slice(-20).forEach((l, i) =>
    console.log(`  [${String(allLines.length - 19 + i).padStart(6)}] ${l.slice(0, 120)}`),
  );

  console.log(`\n次のステップ:`);
  console.log(`  npm run convert:estat-aging-2020`);
  console.log(`  npm run import:aging`);
  console.log(`  npm run score:aging-v1 -- --output data/processed/aging.json`);
  console.log(`  npm run merge:data:strict`);
  console.log(`  npm run validate:data -- --strict`);
  console.log(`  npm run build`);
}

// -------------------------------------------------------
// CLI
// -------------------------------------------------------

if (require.main === module) {
  const outputPath = getArg("--output") ?? DEFAULT_OUTPUT;

  fetchEstatAging(outputPath).catch((e) => {
    console.error(`\nERROR: ${(e as Error).message}`);
    process.exit(1);
  });
}
