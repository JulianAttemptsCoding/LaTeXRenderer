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
 * the gate but not that a 2.5 MB Monaco IIFE actually survives being fetched, hashed, and
 * executed from a `blob:` URL. That is the assumption the entire delivery mechanism rests
 * on, and two things could break it:
 *
 *   1. any surviving ESM `import` at module-evaluation time (relative specifiers inside a
 *      blob resolve against the blob URL and 404),
 *   2. Monaco failing to construct its web worker from the blob URL the shell provides.
 *
 * The suite skips itself, loudly, when the sibling texCompiler build is absent — in CI the
 * two repositories are separate. A skip is reported as a skip, never as a pass.
 */

const DIST = resolve(here, "../../../texCompiler/app/dist");
const REQUIRED = ["app.js", "app.css", "editor.worker.js"];

const available = existsSync(DIST) && REQUIRED.every((f) => existsSync(resolve(DIST, f)));

test.describe("the real editor bundle", () => {
  test.skip(
    !available,
    `Built bundle not found at ${DIST}. Run "node scripts/build-protected-app.mjs" in texCompiler first.`,
  );

  test("is fetched, hash-verified, and executed from a blob URL", async ({ page, state }) => {
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

    // The app creates its own root node and mounts React into it.
    await expect(page.locator("#underrock-root")).toBeAttached({ timeout: 60_000 });
    await expect(page.locator("#underrock-root .dashboard, #underrock-root .workspace")).toBeVisible(
      { timeout: 60_000 },
    );

    // The dashboard is the first thing an authorised user should see.
    await expect(page.getByRole("button", { name: /new blank project/i })).toBeVisible();

    // A module-resolution failure would surface here, not as a missing element.
    const fatal = pageErrors.filter(
      (m) => /Failed to (fetch|resolve) (dynamically imported )?module|Cannot use import statement|Unexpected token 'export'/i.test(m),
    );
    expect(fatal, `module errors: ${fatal.join(" | ")}`).toEqual([]);

    const styleInjected = await page.evaluate(
      () => document.querySelectorAll('style[data-underrock="protected-style"]').length,
    );
    expect(styleInjected).toBeGreaterThan(0);

    const workerUrl = await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__UNDERROCK_WORKER_URL__,
    );
    expect(String(workerUrl)).toMatch(/^blob:/);

    // eslint-disable-next-line no-console
    console.log(`console errors during load: ${consoleErrors.length}`);
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

    await expect(page.getByRole("heading", { name: /refused to start/i })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.locator("#underrock-root")).toHaveCount(0);
  });
});
