import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, signIn, test } from "./fixtures";
import { SUPABASE_HOST } from "./fixtures";

// package.json declares "type": "module", so __dirname does not exist here.
const here = dirname(fileURLToPath(import.meta.url));

/**
 * Loads the REAL protected bundle through the REAL shell loader.
 *
 * Every other test in this suite uses a three-line stand-in for the editor, which proves
 * the gate but not that the Monaco/TeX bundle actually survives being fetched, hashed, and
 * executed from a `blob:` URL. That is the assumption the entire delivery mechanism rests
 * on, and two things could break it:
 *
 *   1. any surviving ESM `import` at module-evaluation time (relative specifiers inside a
 *      blob resolve against the blob URL and 404),
 *   2. Monaco or the TeX engine failing to construct its worker from a verified blob URL.
 *
 * The suite skips itself, loudly, when the sibling texCompiler build is absent — in CI the
 * two repositories are separate. A skip is reported as a skip, never as a pass.
 */

const DIST = resolve(here, "../../../texCompiler/app/dist");
const REQUIRED = ["app.js", "app.css", "editor.worker.js", "compiler.worker.js", "xzwasm.js"];

const available = existsSync(DIST) && REQUIRED.every((f) => existsSync(resolve(DIST, f)));

test.describe("the real editor bundle", () => {
  test.skip(
    !available,
    `Built bundle not found at ${DIST}. Run "node scripts/build-protected-app.mjs" in texCompiler first.`,
  );

  test("is fetched, hash-verified, and executed from a blob URL", async ({ page, state }, testInfo) => {
    const bytes = new Map<string, Buffer>();
    for (const name of REQUIRED) bytes.set(name, readFileSync(resolve(DIST, name)));

    await signIn(page, state);
    state.hasAccess = true;
    state.grantExpiresAt = new Date(Date.now() + 3_600_000).toISOString();

    // Replace the stand-in manifest and asset routes with the genuine article.
    await page.route(`${SUPABASE_HOST}/functions/v1/get-protected-app`, async (route) => {
      const assets = REQUIRED.map((name) => {
        const body = bytes.get(name)!;
        return {
          path: name,
          sha256: createHash("sha256").update(body).digest("hex"),
          size: body.byteLength,
          contentType: name.endsWith(".css") ? "text/css" : "text/javascript",
          url: `${SUPABASE_HOST}/storage/v1/object/sign/protected-app/${name}?token=real`,
        };
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({
          ok: true,
          buildId: "realbundle",
          entry: "app.js",
          styles: ["app.css"],
          worker: "editor.worker.js",
          compilerWorker: "compiler.worker.js",
          xzWasm: "xzwasm.js",
          expiresInSeconds: 300,
          grantExpiresAt: state.grantExpiresAt,
          assets,
        }),
      });
    });

    await page.route(
      `${SUPABASE_HOST}/storage/v1/object/sign/protected-app/**`,
      async (route) => {
        const name = new URL(route.request().url()).pathname.split("/protected-app/")[1] ?? "";
        const body = bytes.get(name);
        if (!body) return route.fulfill({ status: 404, body: "" });
        await route.fulfill({
          status: 200,
          contentType: name.endsWith(".css") ? "text/css" : "text/javascript",
          headers: { "Access-Control-Allow-Origin": "*" },
          body,
        });
      },
    );

    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto("./");
    await page.getByLabel(/access password/i).fill(state.correctPassword);
    await page.getByRole("button", { name: /unlock/i }).click();

    // The app creates its own root node and mounts React into it.
    await expect(page.locator("#latexrenderer-root")).toBeAttached({ timeout: 60_000 });
    await expect(page.locator("#latexrenderer-root .dashboard, #latexrenderer-root .workspace")).toBeVisible(
      { timeout: 60_000 },
    );

    // The dashboard is the first thing an authorised user should see.
    await expect(page.getByRole("button", { name: /new blank project/i })).toBeVisible();

    // Exercise the real editor surfaces added after the shell handoff. This catches
    // protected-bundle-only regressions that component tests cannot see (IndexedDB,
    // Monaco, responsive fixed panels, and the blob worker all participate here).
    // Use the exact thesis template reported by the user. It includes setspace.sty, a
    // package intentionally outside Siglum's prebuilt bundle set, so this exercises the
    // verified XZ decoder and on-demand TeX Live package proxy.
    page.once("dialog", (dialog) => dialog.accept("QA thesis"));
    await page.locator(".dashboard-actions select").selectOption("thesis");
    await expect(page.locator("#latexrenderer-root .workspace")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(".monaco-host")).toBeVisible({ timeout: 60_000 });

    await page.getByRole("button", { name: "History" }).click();
    await expect(page.getByRole("dialog", { name: /version history/i })).toBeVisible();
    await page.getByRole("button", { name: /close history/i }).click();

    await page.getByRole("button", { name: /^Review/ }).click();
    await expect(page.getByRole("complementary", { name: /review and comments/i })).toBeVisible();
    await page.getByRole("button", { name: /close review/i }).click();

    await page.getByRole("button", { name: /^Collaborate/ }).click();
    await expect(page.getByRole("complementary", { name: /live collaboration/i })).toBeVisible();
    await page.getByRole("button", { name: /close collaboration/i }).click();

    // A module-resolution failure would surface here, not as a missing element.
    const fatal = pageErrors.filter(
      (m) => /Failed to (fetch|resolve) (dynamically imported )?module|Cannot use import statement|Unexpected token 'export'/i.test(m),
    );
    expect(fatal, `module errors: ${fatal.join(" | ")}`).toEqual([]);

    const styleInjected = await page.evaluate(
      () => document.querySelectorAll('style[data-latexrenderer="protected-style"]').length,
    );
    expect(styleInjected).toBeGreaterThan(0);

    const workerUrl = await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__LATEXRENDERER_WORKER_URL__,
    );
    expect(String(workerUrl)).toMatch(/^blob:/);

    const compilerWorkerUrl = await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__LATEXRENDERER_COMPILER_WORKER_URL__,
    );
    expect(String(compilerWorkerUrl)).toMatch(/^blob:/);

    const xzWasmUrl = await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__LATEXRENDERER_XZ_WASM_URL__,
    );
    expect(String(xzWasmUrl)).toMatch(/^blob:/);

    // One real TeX Live WebAssembly compile proves this is genuinely install-free, not
    // just UI copy over the old companion requirement. Run once, not again in mobile QA.
    if (testInfo.project.name === "chromium") {
      test.setTimeout(240_000);
      await page.route(`${SUPABASE_HOST}/functions/v1/texlive-package/api/texlive/setspace`, async (route) => {
        const response = await fetch(
          "https://mirrors.ctan.org/systems/texlive/tlnet/archive/setspace.tar.xz",
        );
        await route.fulfill({
          status: response.status,
          contentType: "application/x-xz",
          body: Buffer.from(await response.arrayBuffer()),
        });
      });
      await page.getByRole("button", { name: "Recompile" }).click();
      await expect(page.locator(".output-status")).toContainText(/Built|Failed/, { timeout: 210_000 });
      if ((await page.locator(".output-status").innerText()).includes("Failed")) {
        await page.getByRole("button", { name: "Log" }).click();
        console.log(`browser compiler log:\n${await page.locator("pre.log").innerText()}`);
      }
      await expect(page.locator(".output-status")).toContainText("Built");
      await expect(page.locator("iframe.pdf-frame")).toBeVisible();
      await expect(page.locator(".output-status")).toContainText("Browser TeX Live 2025");

      // The reported production failure used XeLaTeX, so exercise that exact engine too.
      await page.locator('select[title="TeX engine"]').selectOption("xelatex");
      await page.getByRole("button", { name: "Recompile" }).click();
      await expect(page.locator(".output-status")).toContainText("xelatex", { timeout: 210_000 });
      if ((await page.locator(".output-status").innerText()).includes("Failed")) {
        await page.getByRole("button", { name: "Log" }).click();
        console.log(`XeLaTeX browser compiler log:\n${await page.locator("pre.log").innerText()}`);
      }
      await expect(page.locator(".output-status")).toContainText("Built");
    }

    console.log(`console errors during load: ${consoleErrors.length}${consoleErrors.length ? ` — ${consoleErrors.join(" | ")}` : ""}`);
  });

  test("a single flipped byte in the real bundle stops it executing", async ({ page, state }) => {
    const app = readFileSync(resolve(DIST, "app.js"));
    const css = readFileSync(resolve(DIST, "app.css"));

    await signIn(page, state);
    state.hasAccess = true;
    state.grantExpiresAt = new Date(Date.now() + 3_600_000).toISOString();

    await page.route(`${SUPABASE_HOST}/functions/v1/get-protected-app`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({
          ok: true,
          buildId: "realbundle-tampered",
          entry: "app.js",
          styles: ["app.css"],
          worker: null,
          expiresInSeconds: 300,
          grantExpiresAt: state.grantExpiresAt,
          assets: [
            {
              path: "app.js",
              // The hash of the ORIGINAL file; the route below serves a modified one.
              sha256: createHash("sha256").update(app).digest("hex"),
              size: app.byteLength,
              contentType: "text/javascript",
              url: `${SUPABASE_HOST}/storage/v1/object/sign/protected-app/app.js?token=x`,
            },
            {
              path: "app.css",
              sha256: createHash("sha256").update(css).digest("hex"),
              size: css.byteLength,
              contentType: "text/css",
              url: `${SUPABASE_HOST}/storage/v1/object/sign/protected-app/app.css?token=x`,
            },
          ],
        }),
      });
    });

    await page.route(`${SUPABASE_HOST}/storage/v1/object/sign/protected-app/**`, async (route) => {
      const name = new URL(route.request().url()).pathname.split("/protected-app/")[1] ?? "";
      if (name.startsWith("app.js")) {
        // Flip exactly one byte, keeping the length identical so only the digest differs.
        const tampered = Buffer.from(app);
        const at = Math.floor(tampered.length / 2);
        tampered[at] = (tampered[at] ?? 0) ^ 0x01;
        return route.fulfill({
          status: 200,
          contentType: "text/javascript",
          headers: { "Access-Control-Allow-Origin": "*" },
          body: tampered,
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "text/css",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: css,
      });
    });

    await page.goto("./");
    await page.getByLabel(/access password/i).fill(state.correctPassword);
    await page.getByRole("button", { name: /unlock/i }).click();

    await expect(page.getByRole("heading", { name: /refused to start/i })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.locator("#latexrenderer-root")).toHaveCount(0);
  });
});
