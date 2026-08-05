import { expect, test, type Page } from "@playwright/test";

/**
 * Direct mode, against the real build and the real editor bundle.
 *
 * This is the configuration a visitor to
 * https://julianattemptscoding.github.io/LaTeXRenderer/ actually gets, so these tests
 * assert the whole path: land, sign in, boot the 2.5 MB editor from ./app/ with its
 * SHA-256 verified, and reach a usable dashboard.
 *
 * Google's real popup cannot be driven headlessly, so the signed-in state is seeded the
 * way Google Identity Services would leave it. Everything after that point -- manifest
 * fetch, hash verification, blob execution, React mount -- is the genuine code path.
 */

const SESSION_KEY = "underrock.google.session";

/**
 * Puts the browser in the state Google Identity Services would leave it in.
 *
 * Written with an explicit visit + evaluate rather than page.addInitScript, because an
 * init script re-runs on EVERY navigation -- including the reload that sign-out performs,
 * which would silently re-create the session it had just cleared and make the sign-out
 * test unfalsifiable.
 */
async function seedSession(page: Page, email = "tester@example.test") {
  await page.goto("./");
  await page.evaluate(
    ([key, value]) => window.localStorage.setItem(key as string, value as string),
    [
      SESSION_KEY,
      JSON.stringify({
        sub: "1234567890",
        email,
        name: "Test User",
        picture: "",
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ],
  );
}

/** Google's script is blocked so the tests never depend on a third-party network call. */
async function blockGoogle(page: Page) {
  await page.route("https://accounts.google.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: "/* blocked in tests */" }),
  );
}

test.describe("direct mode", () => {
  test.beforeEach(async ({ page }) => {
    await blockGoogle(page);
  });

  test("a first-time visitor sees the mission and a way to sign in", async ({ page }) => {
    await page.goto("./");
    await expect(page.getByRole("heading", { name: /make latex free and open/i })).toBeVisible();
    // Google's own button cannot render (its script is blocked), so the fallback must be
    // present -- the page must never be a dead end.
    await expect(page.getByRole("button", { name: /continue with google/i })).toBeVisible();
    await expect(page.locator("#underrock-root")).toHaveCount(0);
  });

  test("no Supabase call is attempted", async ({ page }) => {
    const supabaseCalls: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes(".supabase.co")) supabaseCalls.push(r.url());
    });
    await page.goto("./");
    await expect(page.getByRole("button", { name: /continue with google/i })).toBeVisible();
    expect(supabaseCalls).toEqual([]);
  });

  test("a signed-in visitor boots the real editor from ./app/", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));

    await seedSession(page);
    await page.goto("./");

    await expect(page.locator("#underrock-root")).toBeAttached({ timeout: 60_000 });
    await expect(
      page.locator("#underrock-root .dashboard, #underrock-root .workspace"),
    ).toBeVisible({ timeout: 60_000 });

    // The things a person needs on arrival.
    await expect(page.getByRole("button", { name: /new blank project/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /import a zip/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /connect google drive/i })).toBeVisible();

    const fatal = pageErrors.filter((m) =>
      /Failed to (fetch|resolve)|Cannot use import statement|Unexpected token 'export'/i.test(m),
    );
    expect(fatal, `module errors: ${fatal.join(" | ")}`).toEqual([]);
  });

  test("the editor assets are hash-verified before they run", async ({ page }) => {
    await seedSession(page);

    // Corrupt app.js in flight, leaving the manifest untouched.
    await page.route("**/app/app.js", async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      await route.fulfill({
        status: 200,
        contentType: "text/javascript",
        body: `${body}\n/* tampered */`,
      });
    });

    await page.goto("./");
    await expect(page.getByRole("heading", { name: /refused to start/i })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.locator("#underrock-root")).toHaveCount(0);
  });

  test("the editor is handed a Google Client ID so Drive works without setup", async ({ page }) => {
    await seedSession(page);
    await page.goto("./");
    await expect(page.locator("#underrock-root .dashboard")).toBeVisible({ timeout: 60_000 });

    const clientId = await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__UNDERROCK_GOOGLE_CLIENT_ID__,
    );
    expect(String(clientId)).toMatch(/\.apps\.googleusercontent\.com$/);

    const mode = await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__UNDERROCK_MODE__,
    );
    expect(mode).toBe("direct");
  });

  test("a new project can be created and edited", async ({ page }) => {
    await seedSession(page);
    await page.goto("./");
    await expect(page.locator("#underrock-root .dashboard")).toBeVisible({ timeout: 60_000 });

    page.once("dialog", (dialog) => void dialog.accept("QA smoke project"));
    await page.getByRole("button", { name: /new blank project/i }).click();

    // The editor view, its file tree, and Monaco itself.
    await expect(page.locator("#underrock-root .workspace")).toBeVisible({ timeout: 30_000 });
    // Scoped to the toolbar: the name also appears in the file tree, and an unscoped
    // getByText would match both and fail Playwright's strict mode.
    await expect(page.locator(".topbar .project-name")).toHaveText("QA smoke project");
    await expect(page.locator('[data-testid="monaco-host"]')).toBeVisible({ timeout: 30_000 });

    // On a narrow screen only one pane fits, so the file tree lives behind the switcher.
    // Reaching it must be possible -- an earlier build hid it with no way to bring it back.
    const switcher = page.locator(".mobile-switch");
    if (await switcher.isVisible()) {
      await switcher.getByRole("button", { name: "Files" }).click();
    }
    await expect(page.locator(".file-tree")).toBeVisible();
    if (await switcher.isVisible()) {
      await switcher.getByRole("button", { name: "Editor" }).click();
    }

    // The starter document must actually be in the editor, not just a blank pane.
    await expect(page.locator(".monaco-host")).toContainText("documentclass", {
      timeout: 30_000,
    });

    // Compiling without the local companion must explain itself rather than hang.
    await expect(page.getByText(/compiler offline/i)).toBeVisible();
  });

  test("no forbidden credential material reaches the browser", async ({ page }) => {
    await page.goto("./");
    const source = await page.evaluate(async () => {
      const parts: string[] = [];
      for (const s of Array.from(document.querySelectorAll("script[src]"))) {
        const src = (s as HTMLScriptElement).src;
        if (src.startsWith("http")) parts.push(await (await fetch(src)).text());
      }
      return parts.join("\n");
    });

    // A Google client SECRET must never ship. The Client ID is public by design and is
    // expected to be present, so it is deliberately not asserted against.
    expect(source, "a Google client secret").not.toMatch(/\bGOCSPX-[A-Za-z0-9_-]{10,}/);
    expect(source, "a service-role JWT").not.toMatch(
      /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]*service_role/,
    );
    expect(source, "a Supabase secret key").not.toMatch(/\bsb_secret_[A-Za-z0-9_-]{10,}/);
  });

  test("signing out clears the session and returns to the landing page", async ({ page }) => {
    await seedSession(page);
    await page.goto("./");
    await expect(page.locator("#underrock-root .dashboard")).toBeVisible({ timeout: 60_000 });

    await page.evaluate(() => window.dispatchEvent(new CustomEvent("underrock:sign-out")));

    await expect(page.getByRole("button", { name: /continue with google/i })).toBeVisible({
      timeout: 30_000,
    });
    const session = await page.evaluate((key) => localStorage.getItem(key), SESSION_KEY);
    expect(session).toBeNull();
  });
});
