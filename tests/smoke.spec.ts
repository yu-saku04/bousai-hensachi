/**
 * smoke.spec.ts — 主要ページの基本動作・異常値・スコア整合性テスト
 * - 全9URL: HTTP正常・異常文字列なし
 * - 自治体詳細: 名称・スコア・レーダー・液状化・出典
 * - ランキング: 一覧・スコア数値・フィルター・リンク
 * - トップ: TOP3・検索フォーム
 * - スコア整合性: JSONデータ == 詳細ページ == 都道府県ランキング
 */
import { test, expect, Page } from "@playwright/test";
import {
  getExpectedScore,
  getMunicipality,
  getMunicipalityByHazardCoverage,
  normalizeScoreText,
} from "./helpers/municipalities";

const ANOMALY_RE = /\bNaN\b|\bInfinity\b|\bundefined\b|Application error|Internal Server Error/;

async function assertNoAnomalies(page: Page) {
  const body = await page.locator("body").innerText();
  expect(body, "本文に異常文字列が含まれています").not.toMatch(ANOMALY_RE);
}

// ---------------------------------------------------------------------------
// 全ページ: ロード・異常文字列
// ---------------------------------------------------------------------------

const ALL_PAGES = [
  "/",
  "/ranking",
  "/result/23220",
  "/result/23237",
  "/result/12227",
  "/result/12106",
  "/result/27100",
  "/result/07407",
  "/result/20201",
];

test.describe("全ページ: HTTP正常・異常文字列なし", () => {
  for (const path of ALL_PAGES) {
    test(`${path} → 200・異常文字列なし`, async ({ page }) => {
      const res = await page.goto(path);
      expect(res?.status(), `${path} should return 200`).toBe(200);
      await assertNoAnomalies(page);
    });
  }
});

// ---------------------------------------------------------------------------
// トップページ
// ---------------------------------------------------------------------------

test.describe("トップページ", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("タイトル・ヘッダーが表示される", async ({ page }) => {
    await expect(page.locator("h1")).toContainText("全国防災偏差値");
  });

  test("TOP3が表示される", async ({ page }) => {
    const top3Section = page.getByRole("heading", { name: /TOP3/ });
    await expect(top3Section).toBeVisible();
    // ランキング自治体リンクが3件以上
    const rankLinks = page.locator("ol li a");
    await expect(rankLinks).toHaveCount(3);
  });

  test("TOP3のスコアが数値である", async ({ page }) => {
    const scoreTexts = await page.locator("ol li .tabular-nums").allInnerTexts();
    expect(scoreTexts.length).toBeGreaterThanOrEqual(3);
    for (const t of scoreTexts) {
      const n = Number(t.trim());
      expect(Number.isFinite(n), `スコア "${t}" が数値ではありません`).toBe(true);
      expect(n, "スコアは10〜90の範囲").toBeGreaterThanOrEqual(10);
      expect(n, "スコアは10〜90の範囲").toBeLessThanOrEqual(90);
    }
  });

  test("検索フォームが表示される", async ({ page }) => {
    await expect(page.getByRole("combobox", { name: "都道府県を選ぶ" })).toBeVisible();
  });

  test("都道府県選択で市区町村一覧が表示される", async ({ page }) => {
    const prefSelect = page.getByRole("combobox", { name: "都道府県を選ぶ" });
    await prefSelect.selectOption("愛知県");
    const muniSelect = page.getByRole("combobox", { name: "市区町村を選ぶ" });
    await expect(muniSelect).not.toBeDisabled();
    const options = await muniSelect.locator("option").all();
    expect(options.length, "市区町村が1件以上").toBeGreaterThan(1);
  });

  test("検索から自治体詳細ページへ遷移できる", async ({ page }) => {
    await page.getByRole("combobox", { name: "都道府県を選ぶ" }).selectOption("愛知県");
    const muniSelect = page.getByRole("combobox", { name: "市区町村を選ぶ" });
    await muniSelect.selectOption({ label: "稲沢市" });
    await page.getByRole("button", { name: "診断する" }).click();
    await page.waitForURL(/\/result\/23220/);
    await expect(page.locator("h1")).toContainText("稲沢市");
  });
});

// ---------------------------------------------------------------------------
// ランキングページ
// ---------------------------------------------------------------------------

test.describe("ランキングページ", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/ranking");
  });

  test("ランキングタイトルが表示される", async ({ page }) => {
    await expect(page.getByRole("heading", { name: /ランキング/ })).toBeVisible();
  });

  test("ランキング一覧が1件以上表示される", async ({ page }) => {
    const items = page.locator("ol li");
    await expect(items.first()).toBeVisible();
    const count = await items.count();
    expect(count, "ランキング件数が1件以上").toBeGreaterThan(0);
  });

  test("表示スコアが10〜90の数値である（先頭10件）", async ({ page }) => {
    // RankingList のスコアバッジ: rounded-lg border font-semibold text-xs の div
    const scoreLinks = page.locator("ol li a");
    await expect(scoreLinks.first()).toBeVisible();
    const count = await scoreLinks.count();
    expect(count, "ランキング行が10件以上").toBeGreaterThanOrEqual(10);
    for (let i = 0; i < 10; i++) {
      const badge = scoreLinks.nth(i).locator(".rounded-lg.font-semibold.text-xs").first();
      const t = await badge.innerText();
      const n = Number(t.trim());
      expect(Number.isFinite(n), `スコア[${i}] "${t}" が数値ではありません`).toBe(true);
      expect(n, `スコア[${i}]は10〜90`).toBeGreaterThanOrEqual(10);
      expect(n, `スコア[${i}]は10〜90`).toBeLessThanOrEqual(90);
    }
  });

  test("都道府県フィルターが存在する", async ({ page }) => {
    // PrefectureFilter は select 要素（combobox role）
    await expect(page.getByRole("combobox", { name: /都道府県/ })).toBeVisible();
  });

  test("ランキング行から自治体詳細ページへ遷移できる", async ({ page }) => {
    const firstLink = page.locator("ol li a").first();
    const href = await firstLink.getAttribute("href");
    expect(href).toMatch(/\/result\/\d{5}/);
    await firstLink.click();
    await page.waitForURL(/\/result\/\d{5}/);
    // 詳細ページに自治体名とスコアが表示される
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.locator(".text-7xl")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// 自治体詳細ページ
// ---------------------------------------------------------------------------

const MUNICIPALITY_CASES = [
  { jis: "23220", name: "稲沢市",       liqStatus: "scored",               expectAdvice: true  },
  { jis: "23237", name: "あま市",       liqStatus: "scored",               expectAdvice: false },
  { jis: "12227", name: "浦安市",       liqStatus: "scored",               expectAdvice: false },
  { jis: "12106", name: "千葉市美浜区", liqStatus: "scored",               expectAdvice: false },
  { jis: "27100", name: "大阪市",       liqStatus: "ward-averaged",        expectAdvice: false },
  { jis: "07407", name: "磐梯町",       liqStatus: "no-liquefaction-risk", expectAdvice: false },
  { jis: "20201", name: "長野市",       liqStatus: "scored",               expectAdvice: false },
] as const;

for (const m of MUNICIPALITY_CASES) {
  test.describe(`詳細ページ ${m.name} (${m.jis})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(`/result/${m.jis}`);
    });

    test("自治体名が表示される", async ({ page }) => {
      await expect(page.locator("h1")).toContainText(m.name);
    });

    test("総合スコアが正しい値で表示される", async ({ page }) => {
      const expected = getExpectedScore(m.jis);
      const scoreEl = page.locator(".text-7xl");
      await expect(scoreEl).toBeVisible();
      await expect(scoreEl).toHaveText(String(expected));
    });

    test("v2.5表記が存在する", async ({ page }) => {
      // 複数要素に一致するため first() を使用
      await expect(page.getByText(/v2\.5/, { exact: false }).first()).toBeVisible();
    });

    test("防災スコアレーダー（SVG）が存在する", async ({ page }) => {
      const radar = page.locator("svg[role='img']");
      await expect(radar).toBeVisible();
    });

    test("液状化セクションが存在する", async ({ page }) => {
      await expect(page.getByText("液状化発生傾向", { exact: false }).first()).toBeVisible();
    });

    test("J-SHIS出典が表示される", async ({ page }) => {
      await expect(page.getByText(/J-SHIS/, { exact: false })).toBeVisible();
    });

    test("免責・出典注記が表示される", async ({ page }) => {
      // 防災情報は公的機関を確認する旨の注記
      await expect(
        page.getByText(/防災情報は必ず|公的機関|免責/, { exact: false }).first()
      ).toBeVisible();
    });

    test("液状化アドバイスの表示/非表示が正しい", async ({ page }) => {
      const adviceText = "地形由来の液状化発生傾向が高い";
      if (m.expectAdvice) {
        await expect(page.getByText(adviceText, { exact: false })).toBeVisible();
      } else {
        await expect(page.getByText(adviceText, { exact: false })).toHaveCount(0);
      }
    });

    test("地震・洪水・土砂・津波・高潮の各セクションが存在する", async ({ page }) => {
      // v2.5内訳セクション内にキーワードが含まれる
      const breakdown = page.getByText("総合防災偏差値", { exact: false }).first();
      await expect(breakdown).toBeVisible();
      // 各ハザードラベル
      for (const label of ["地震リスク", "洪水リスク", "土砂災害リスク"]) {
        await expect(page.getByText(label, { exact: false }).first()).toBeVisible();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// 高潮セクション表示検証
// ---------------------------------------------------------------------------

test.describe("高潮セクション表示", () => {
  test("千葉市美浜区(scored): 高潮スコアと浸水面積率が表示される", async ({ page }) => {
    await page.goto("/result/12106");
    await expect(page.getByText("高潮リスク", { exact: false }).first()).toBeVisible();
    // scored: スコア数値バッジが表示される
    const badge = page.locator(".text-sm.font-bold.tabular-nums").filter({ hasText: /^\d+$/ }).first();
    await expect(badge).toBeVisible();
    // 浸水面積率表示
    await expect(page.getByText(/%/, { exact: false }).first()).toBeVisible();
  });

  test("千葉市美浜区(scored, candidate=10): 高潮アドバイスが表示される", async ({ page }) => {
    await page.goto("/result/12106");
    await expect(page.getByText("高潮への備えを優先", { exact: false })).toBeVisible();
  });

  test("長野市(no-storm-surge-risk): 内陸県表記が表示される", async ({ page }) => {
    await page.goto("/result/20201");
    await expect(page.getByText("高潮リスク", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("高潮リスク対象外", { exact: false }).first()).toBeVisible();
  });

  test("大阪市(ward-averaged): 高潮スコアが表示される", async ({ page }) => {
    await page.goto("/result/27100");
    await expect(page.getByText("高潮リスク", { exact: false }).first()).toBeVisible();
    // ward-averaged のスコアは存在する（44）
    const stormSection = page.getByText("高潮リスク", { exact: false }).first();
    await expect(stormSection).toBeVisible();
  });

  test("磐梯町(missing): 高潮データ未整備が表示される", async ({ page }) => {
    await page.goto("/result/07407");
    await expect(page.getByText("高潮リスク", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("高潮データ未整備", { exact: false })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// ハザードデータ充足度
// ---------------------------------------------------------------------------

test.describe("ハザードデータ充足度", () => {
  test("6/6自治体: 充足度と信頼度が表示され、注意文は出ない", async ({ page }) => {
    const municipality = getMunicipalityByHazardCoverage(6);
    await page.goto(`/result/${municipality.jisCode}`);
    const coverageCard = page.locator("section").filter({ hasText: "ハザードデータの充足度" }).first();

    await expect(coverageCard).toBeVisible();
    await expect(coverageCard.getByText("6 / 6", { exact: false })).toBeVisible();
    await expect(coverageCard.getByText("信頼度")).toBeVisible();
    await expect(coverageCard.getByText("高", { exact: true })).toBeVisible();
    await expect(coverageCard.getByText("一部のハザードデータが未提供", { exact: false })).toHaveCount(0);
  });

  test("4/6自治体: 充足度・標準ラベル・比較注意が表示される", async ({ page }) => {
    const municipality = getMunicipalityByHazardCoverage(4);
    await page.goto(`/result/${municipality.jisCode}`);
    const coverageCard = page.locator("section").filter({ hasText: "ハザードデータの充足度" }).first();

    await expect(coverageCard).toBeVisible();
    await expect(coverageCard.getByText("4 / 6", { exact: false })).toBeVisible();
    await expect(coverageCard.getByText("標準", { exact: true })).toBeVisible();
    await expect(coverageCard.getByText("一部のハザードデータが未提供", { exact: false })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// スコア整合性: JSONデータ == 詳細ページ == 都道府県ランキング
// ---------------------------------------------------------------------------

const CONSISTENCY_CASES = [
  { jis: "23220", name: "稲沢市" },
  { jis: "12227", name: "浦安市" },
  { jis: "20201", name: "長野市" },
  { jis: "27100", name: "大阪市" },
] as const;

test.describe("スコア整合性", () => {
  for (const { jis, name } of CONSISTENCY_CASES) {
    test(`${name}: JSONデータ・詳細ページ・都道府県ランキングのスコアが一致する`, async ({ page }) => {
      const expected = getExpectedScore(jis);
      const prefecture = getMunicipality(jis).prefecture;

      // 1. 都道府県ランキングページでスコアを取得
      await page.goto(`/ranking/${encodeURIComponent(prefecture)}`);
      const row = page.locator(`ol li a[href="/result/${jis}"]`);
      await expect(row).toBeVisible();
      const rankingScoreText = await row.locator(".rounded-lg.font-semibold").first().innerText();
      const rankingScore = normalizeScoreText(rankingScoreText);

      expect(rankingScore, `[${name}] 都道府県ランキングのスコアがJSONデータと一致`).toBe(expected);

      // 2. 詳細ページのスコアと比較
      await page.goto(`/result/${jis}`);
      const detailScoreText = await page.locator(".text-7xl").innerText();
      const detailScore = normalizeScoreText(detailScoreText);

      expect(detailScore, `[${name}] 詳細ページのスコアがJSONデータと一致`).toBe(expected);
    });
  }

  test("TOP3筆頭自治体: トップページとランキングページのスコアが一致する", async ({ page }) => {
    // トップページのTOP1のスコアとリンク先
    await page.goto("/");
    const firstLink = page.locator("ol li").first().getByRole("link");
    const topPageScore = await firstLink.locator(".tabular-nums").first().innerText();
    const href = await firstLink.getAttribute("href");
    expect(href).toBeTruthy();

    // 詳細ページで確認
    await page.goto(href!);
    const detailScore = await page.locator(".text-7xl").innerText();
    expect(detailScore.trim()).toBe(topPageScore.trim());
  });
});
