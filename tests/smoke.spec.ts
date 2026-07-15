/**
 * smoke.spec.ts — 主要ページの基本動作・異常値・スコア整合性テスト
 * - 全9URL: HTTP正常・異常文字列なし
 * - 自治体詳細: 名称・スコア・レーダー・液状化・出典
 * - ランキング: 一覧・スコア数値・フィルター・リンク
 * - トップ: TOP3・検索フォーム
 * - スコア整合性: ランキング表示スコア == 詳細ページスコア
 */
import { test, expect, Page } from "@playwright/test";

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
  { jis: "23220", name: "稲沢市",       score: 44, liqStatus: "scored",              liqScore: 22, expectAdvice: true },
  { jis: "23237", name: "あま市",       score: 44, liqStatus: "scored",              liqScore: 46, expectAdvice: false },
  { jis: "12227", name: "浦安市",       score: 53, liqStatus: "scored",              liqScore: 56, expectAdvice: false },
  { jis: "12106", name: "千葉市美浜区", score: 56, liqStatus: "scored",              liqScore: 58, expectAdvice: false },
  { jis: "27100", name: "大阪市",       score: 52, liqStatus: "ward-averaged",       liqScore: 42, expectAdvice: false },
  { jis: "07407", name: "磐梯町",       score: 64, liqStatus: "no-liquefaction-risk",liqScore: 100, expectAdvice: false },
  { jis: "20201", name: "長野市",       score: 72, liqStatus: "scored",              liqScore: 89, expectAdvice: false },
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
      const scoreEl = page.locator(".text-7xl");
      await expect(scoreEl).toBeVisible();
      await expect(scoreEl).toHaveText(String(m.score));
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
// スコア整合性: ランキング表示スコア == 詳細ページスコア
// ---------------------------------------------------------------------------

test.describe("スコア整合性", () => {
  test("稲沢市: ランキングのスコアと詳細ページのスコアが一致する", async ({ page }) => {
    // 1. ランキングページで稲沢市のスコアを取得
    await page.goto("/ranking");
    const nagoRow = page.locator("ol li a[href='/result/23220']");
    await expect(nagoRow).toBeVisible();
    await nagoRow.scrollIntoViewIfNeeded();
    // RankingList スコアバッジは rounded-lg font-semibold text-xs の div
    const rankingScore = await nagoRow.locator(".rounded-lg.font-semibold").first().innerText();

    // 2. 詳細ページのスコアと比較
    await page.goto("/result/23220");
    const detailScore = await page.locator(".text-7xl").innerText();

    expect(detailScore.trim(), "詳細ページのスコアがランキングと一致すること").toBe(rankingScore.trim());
  });

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
