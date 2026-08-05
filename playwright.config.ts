import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end suite for the public shell.
 *
 * These tests run against the real built bundle served by `vite preview`, with Supabase
 * network calls intercepted. That combination is deliberate: it proves the *shipped*
 * JavaScript behaves correctly, while keeping the suite runnable in CI without a live
 * Supabase project or a real Google account.
 *
 * The security assertions here are the ones that matter most -- that DOM edits, storage
 * edits, and console calls cannot manufacture access -- and they are meaningful precisely
 * because the shell holds no authority to subvert.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  timeout: 30_000,
  expect: { timeout: 7_000 },

  use: {
    baseURL: "http://localhost:4173/UnderRock/",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],

  webServer: {
    command: "npm run build && npm run preview",
    url: "http://localhost:4173/UnderRock/",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      VITE_SUPABASE_URL: process.env.VITE_SUPABASE_URL ?? "https://e2etest.supabase.co",
      VITE_SUPABASE_ANON_KEY: process.env.VITE_SUPABASE_ANON_KEY ?? "e2e-anon-key",
    },
  },
});
