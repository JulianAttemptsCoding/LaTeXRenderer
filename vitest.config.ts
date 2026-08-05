import { defineConfig } from "vitest/config";

// Vitest configuration is kept out of vite.config.ts because `test` is not part of Vite's
// own UserConfig type, and typecheck runs over both files.
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/unit/**/*.test.ts"],
    setupFiles: ["tests/unit/setup.ts"],
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text-summary"],
    },
  },
});
