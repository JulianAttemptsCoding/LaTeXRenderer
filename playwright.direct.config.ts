import { defineConfig, devices } from "@playwright/test";

/**
 * Direct-mode end-to-end suite.
 *
 * A separate config because the mode is decided at BUILD time by whether the Supabase
 * variables are present. The main suite builds with them set; this one builds without, on
 * its own port, so both modes are exercised against real bundles rather than a flag that
 * only exists in tests.
 */
export default defineConfig({
  testDir: "./tests/direct",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["github"]] : [["list"]],
  timeout: 90_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: "http://localhost:4174/",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],

  webServer: {
    // No VITE_SUPABASE_* on purpose -- that absence is what selects direct mode.
    command: "npm run build && npx vite preview --port 4174 --strictPort",
    url: "http://localhost:4174/",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
