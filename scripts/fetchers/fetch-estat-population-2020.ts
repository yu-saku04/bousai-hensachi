/**
 * e-Stat API v3.0 を使って令和2年国勢調査 表1-1-1 の CSV を取得する。
 *
 * 前提:
 *   .env.local に ESTAT_APP_ID=<アプリケーションID> を設定すること。
 *   APIキーは https://www.e-stat.go.jp/mypage/user/preregister で無料取得できる。
 *
 * 使い方:
 *   npm run fetch:estat-population-2020
 *   tsx scripts/fetchers/fetch-estat-population-2020.ts [--output PATH]
 *
 * 出力:
 *   data/raw/estat/population-2020.csv
 */

import fs from "fs";
import path from "path";

// -------------------------------------------------------
// 定数
// -------------------------------------------------------

const STATS_DATA_ID  = "0003445078";
const DEFAULT_OUTPUT = "data/raw/estat/population-2020.csv";

// e-Stat API v3.0 getSimpleStatsData (CSV形式)
// downloadKind=1 → CSV, sectionHeaderFlg=1 → ヘッダー行あり
const API_BASE =
  "https://api.e-stat.go.jp/rest/3.0/app/getSimpleStatsData";

// -------------------------------------------------------
// ユーティリティ
// -------------------------------------------------------

function getArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** .env.local を手動パース（dotenv 不使用） */
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

// -------------------------------------------------------
// メイン
// -------------------------------------------------------

async function fetchEstatPopulation(outputPath: string): Promise<void> {
  // .env.local を読み込む
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
      `  4. 再度このコマンドを実行: npm run fetch:estat-population-2020\n\n` +
      `  ※ .env.local は .gitignore で除外済みです。絶対にGitにコミットしないでください。`,
    );
  }

  // URLを組み立て（APIキーはログに出さない）
  const params = new URLSearchParams({
    appId:          appId,
    statsDataId:    STATS_DATA_ID,
    downloadKind:   "1",    // 1 = CSV
    sectionHeaderFlg: "1",  // ヘッダー行あり
    metaGetFlg:     "N",    // メタデータ不要
    cntGetFlg:      "N",
  });
  const url = `${API_BASE}?${params.toString()}`;
  const safeUrl = `${API_BASE}?statsDataId=${STATS_DATA_ID}&downloadKind=1&...`;

  console.log(`e-Stat API リクエスト: ${safeUrl}`);
  console.log(`statsDataId: ${STATS_DATA_ID}`);

  // HTTP リクエスト
  let resp: Response;
  try {
    resp = await fetch(url);
  } catch (e) {
    throw new Error(`HTTP リクエスト失敗: ${(e as Error).message}`);
  }

  if (!resp.ok) {
    throw new Error(
      `HTTP エラー: ${resp.status} ${resp.statusText}\n` +
      `  エンドポイント: ${safeUrl}`,
    );
  }

  const contentType = resp.headers.get("content-type") ?? "";

  // JSON が返ってきた場合はAPIエラー
  if (contentType.includes("json")) {
    const body = await resp.json() as Record<string, unknown>;
    const status  = (body["GET_STATS_DATA"] as Record<string,unknown> | undefined)
      ?? body;
    throw new Error(
      `e-Stat API エラー (JSON レスポンス):\n  ${JSON.stringify(status, null, 2)}\n\n` +
      `  アプリケーションID (ESTAT_APP_ID) が正しいか確認してください。`,
    );
  }

  const csvText = await resp.text();

  if (!csvText || csvText.trim().length === 0) {
    throw new Error("e-Stat API からの CSV レスポンスが空です");
  }

  // 出力ディレクトリ作成
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, csvText, "utf-8");

  // 結果表示
  const lines = csvText.split("\n");
  const sizeKb = (Buffer.byteLength(csvText, "utf-8") / 1024).toFixed(1);

  console.log(`\n✅ 保存完了: ${outputPath}`);
  console.log(`   ファイルサイズ: ${sizeKb} KB`);
  console.log(`   総行数: ${lines.length} 行`);
  console.log(`\n先頭5行プレビュー:`);
  lines.slice(0, 5).forEach((l, i) => console.log(`  [${i + 1}] ${l.slice(0, 120)}`));

  console.log(`\n次のステップ:`);
  console.log(`  npm run convert:estat-population-2020`);
  console.log(`  npm run import:population`);
  console.log(`  npm run merge:data:strict`);
  console.log(`  npm run validate:data -- --strict`);
  console.log(`  npm run build`);
}

// -------------------------------------------------------
// CLI
// -------------------------------------------------------

if (require.main === module) {
  const outputPath = getArg("--output") ?? DEFAULT_OUTPUT;

  fetchEstatPopulation(outputPath).catch((e) => {
    console.error(`\nERROR: ${(e as Error).message}`);
    process.exit(1);
  });
}
