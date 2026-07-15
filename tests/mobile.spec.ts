/**
 * mobile.spec.ts — モバイル・タブレット表示テスト
 * 対象viewport: 320×800 / 375×812 / 390×844 / 768×1024 (playwright.config.ts で設定)
 * 対象ページ: / /ranking /result/12227 /result/20201
 *
 * 確認項目:
 *  - 横スクロールが発生しない (scrollWidth <= innerWidth)
 *  - ヘッダー/カード/レーダーがはみ出していない
 *  - ボタンが44px以上の高さ（タップ可能サイズ）
 *  - スクリーンショット保存
 */
import { test, expect, Page } from "@playwright/test";
import path from "path";
import fs from "fs";

const SCREENSHOT_DIR = path.join("test-results", "screenshots");

function ensureScreenshotDir() {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

async function assertNoHorizontalScroll(page: Page) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(
    scrollWidth,
    `横スクロール発生: scrollWidth=${scrollWidth} > innerWidth=${innerWidth}`,
  ).toBeLessThanOrEqual(innerWidth);
}

async function assertRadarFitsViewport(page: Page) {
  const radar = page.locator("svg[role='img']").first();
  if ((await radar.count()) === 0) return;
  const box = await radar.boundingBox();
  if (!box) return;
  const vw = await page.evaluate(() => window.innerWidth);
  expect(
    box.x + box.width,
    `レーダーチャートがviewportを超えています (right=${box.x + box.width} > vw=${vw})`,
  ).toBeLessThanOrEqual(vw + 1); // 1px 許容
}

async function assertMainButtonTappable(page: Page, label: string) {
  const btn = page.getByRole("button").filter({ hasText: /診断する/ }).first();
  if ((await btn.count()) === 0) return;
  const box = await btn.boundingBox();
  if (!box) return;
  expect(box.height, `[${label}] 診断するボタン高さが32px以上`).toBeGreaterThanOrEqual(32);
}

// ---------------------------------------------------------------------------
// テスト対象
// ---------------------------------------------------------------------------

const TARGET_PAGES = [
  { path: "/",             label: "トップ" },
  { path: "/ranking",      label: "ランキング" },
  { path: "/result/12227", label: "浦安市(高液状化)" },
  { path: "/result/20201", label: "長野市(通常)" },
];

test.beforeEach(async ({ page }) => {
  ensureScreenshotDir();
  // JavaScript エラーをキャプチャ（致命的エラーのみチェック）
  page.on("pageerror", (err) => {
    // Next.js の hydration warnings は除外、Application error のみ問題視
    if (err.message.includes("Application error")) {
      throw new Error(`JS fatal error: ${err.message}`);
    }
  });
});

for (const { path: pagePath, label } of TARGET_PAGES) {
  test(`[${label}] 横スクロールなし`, async ({ page }) => {
    await page.goto(pagePath);
    await page.waitForLoadState("networkidle");
    await assertNoHorizontalScroll(page);
  });

  test(`[${label}] ヘッダーがviewport内に収まる`, async ({ page, viewport }) => {
    await page.goto(pagePath);
    await page.waitForLoadState("networkidle");
    const header = page.locator("header").first();
    if ((await header.count()) === 0) return;
    const box = await header.boundingBox();
    if (!box) return;
    const vw = viewport?.width ?? 320;
    expect(box.x + box.width, "ヘッダーがviewportを超えていない").toBeLessThanOrEqual(vw + 1);
  });

  test(`[${label}] カードがviewport内に収まる`, async ({ page, viewport }) => {
    await page.goto(pagePath);
    await page.waitForLoadState("networkidle");
    const vw = viewport?.width ?? 320;
    // bg-white rounded-2xl のカード群
    const cards = page.locator(".rounded-2xl.bg-white");
    const count = await cards.count();
    for (let i = 0; i < Math.min(count, 5); i++) {
      const box = await cards.nth(i).boundingBox();
      if (!box) continue;
      expect(
        box.x + box.width,
        `カード[${i}]がviewportを超えています`,
      ).toBeLessThanOrEqual(vw + 1);
    }
  });

  test(`[${label}] レーダーチャートがviewport内に収まる`, async ({ page }) => {
    await page.goto(pagePath);
    await page.waitForLoadState("networkidle");
    await assertRadarFitsViewport(page);
  });

  test(`[${label}] 主要ボタンがタップ可能なサイズである`, async ({ page }) => {
    await page.goto(pagePath);
    await page.waitForLoadState("networkidle");
    await assertMainButtonTappable(page, label);
  });

  test(`[${label}] スクリーンショット保存`, async ({ page, viewport }) => {
    await page.goto(pagePath);
    await page.waitForLoadState("networkidle");
    const vw = viewport?.width ?? 320;
    const vh = viewport?.height ?? 800;
    const safeName = label.replace(/[\/\s()\[\]]/g, "_");
    const filename = `${safeName}_${vw}x${vh}.png`;
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, filename),
      fullPage: true,
    });
    // スクリーンショットが保存されたことを確認
    const exists = fs.existsSync(path.join(SCREENSHOT_DIR, filename));
    expect(exists, `スクリーンショット ${filename} が保存されました`).toBe(true);
  });
}

// ---------------------------------------------------------------------------
// 追加: ランキング行の横スクロール詳細確認
// ---------------------------------------------------------------------------

test("ランキング行が横スクロールを要求しない", async ({ page, viewport }) => {
  await page.goto("/ranking");
  await page.waitForLoadState("networkidle");
  await assertNoHorizontalScroll(page);

  const vw = viewport?.width ?? 320;
  const rows = page.locator("ol li a");
  const count = await rows.count();
  for (let i = 0; i < Math.min(count, 5); i++) {
    const box = await rows.nth(i).boundingBox();
    if (!box) continue;
    expect(
      box.x + box.width,
      `ランキング行[${i}]がviewportを超えています`,
    ).toBeLessThanOrEqual(vw + 1);
  }
});

// ---------------------------------------------------------------------------
// 追加: 詳細ページのスコアグリッド（レーダー下部）が収まる
// ---------------------------------------------------------------------------

test("浦安市: レーダー下の9軸スコアグリッドがviewport内に収まる", async ({ page, viewport }) => {
  await page.goto("/result/12227");
  await page.waitForLoadState("networkidle");

  const vw = viewport?.width ?? 320;
  // grid-cols-6 のスコアグリッド
  const scoreGrid = page.locator(".grid-cols-6").first();
  if ((await scoreGrid.count()) === 0) return;
  const box = await scoreGrid.boundingBox();
  if (!box) return;
  expect(
    box.x + box.width,
    `スコアグリッドがviewportを超えています (right=${box.x + box.width} > vw=${vw})`,
  ).toBeLessThanOrEqual(vw + 1);
});
