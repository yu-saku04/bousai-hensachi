import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3100);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  webServer: {
    command: `npm run start -- -p ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [
    {
      name: "desktop",
      testMatch: ["smoke.spec.ts"],
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile-320",
      testMatch: ["mobile.spec.ts"],
      use: { viewport: { width: 320, height: 800 } },
    },
    {
      name: "mobile-375",
      testMatch: ["mobile.spec.ts"],
      use: { viewport: { width: 375, height: 812 } },
    },
    {
      name: "mobile-390",
      testMatch: ["mobile.spec.ts"],
      use: { viewport: { width: 390, height: 844 } },
    },
    {
      name: "tablet-768",
      testMatch: ["mobile.spec.ts"],
      use: { viewport: { width: 768, height: 1024 } },
    },
  ],
});
