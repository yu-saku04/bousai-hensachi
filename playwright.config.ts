import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  webServer: {
    command: "npm run start",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
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
