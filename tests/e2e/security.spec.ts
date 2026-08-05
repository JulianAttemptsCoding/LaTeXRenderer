import { expect, signIn, test } from "./fixtures";

/**
 * The security suite.
 *
 * Each test corresponds to a numbered requirement in docs/SECURITY_MODEL.md. They all
 * attack the shell the way a curious user with DevTools would, and they all pass for the
 * same underlying reason: the shell holds no authority. Access lives in a server-side
 * grant, and the bundle is only signed for a caller who already has one.
 */

test.describe("gate cannot be bypassed from the browser", () => {
  test("an unauthenticated visitor sees only the landing page", async ({ page }) => {
    await page.goto("./");
    await expect(page.getByRole("button", { name: /continue with google/i })).toBeVisible();
    await expect(page.locator("#editor-root")).toHaveCount(0);
  });

  test("signed in but ungranted, the password form is shown and no bundle is fetched", async ({
    page,
    state,
  }) => {
    await signIn(page, state);
    await page.goto("./");
    await expect(page.getByLabel(/access password/i)).toBeVisible();
    await expect(page.locator("#editor-root")).toHaveCount(0);
    expect(state.calls.some((c) => c.includes("get-protected-app"))).toBe(false);
  });

  test("removing the password form from the DOM grants nothing", async ({ page, state }) => {
    await signIn(page, state);
    await page.goto("./");
    await expect(page.getByLabel(/access password/i)).toBeVisible();

    // The classic attempt: delete the gate and see what is underneath.
    await page.evaluate(() => {
      document.querySelectorAll("form, .card").forEach((n) => n.remove());
    });

    await page.waitForTimeout(500);
    await expect(page.locator("#editor-root")).toHaveCount(0);
    expect(state.hasAccess).toBe(false);
  });

  test("editing localStorage and sessionStorage grants nothing", async ({ page, state }) => {
    await signIn(page, state);
    await page.goto("./");
    await expect(page.getByLabel(/access password/i)).toBeVisible();

    await page.evaluate(() => {
      localStorage.setItem("underrock.hasAccess", "true");
      localStorage.setItem("hasAccess", "true");
      localStorage.setItem("authorized", "1");
      localStorage.setItem("underrock.grant", JSON.stringify({ hasAccess: true }));
      sessionStorage.setItem("unlocked", "yes");
      sessionStorage.setItem("underrock.siteAccess", "granted");
      document.cookie = "underrock_access=granted; path=/";
    });
    await page.reload();

    await expect(page.getByLabel(/access password/i)).toBeVisible();
    await expect(page.locator("#editor-root")).toHaveCount(0);
    expect(state.hasAccess).toBe(false);
  });

  test("dispatching the shell's own events from the console grants nothing", async ({
    page,
    state,
  }) => {
    await signIn(page, state);
    await page.goto("./");
    await expect(page.getByLabel(/access password/i)).toBeVisible();

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("underrock:unlock"));
      window.dispatchEvent(new CustomEvent("underrock:granted"));
      (window as unknown as Record<string, unknown>).__UNDERROCK_BUILD__ = "forged";
    });
    await page.waitForTimeout(400);

    await expect(page.locator("#editor-root")).toHaveCount(0);
    expect(state.hasAccess).toBe(false);
  });

  test("requesting the bundle endpoint directly without a grant is refused", async ({
    page,
    state,
  }) => {
    await signIn(page, state);
    await page.goto("./");
    await expect(page.getByLabel(/access password/i)).toBeVisible();

    const status = await page.evaluate(async () => {
      const response = await fetch(
        "https://e2etest.supabase.co/functions/v1/get-protected-app",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer e2e-access-token",
          },
          body: "{}",
        },
      );
      return response.status;
    });

    expect(status).toBe(403);
  });

  test("requesting a storage object directly without a grant is refused", async ({
    page,
    state,
  }) => {
    await signIn(page, state);
    await page.goto("./");

    const status = await page.evaluate(async () => {
      const response = await fetch(
        "https://e2etest.supabase.co/storage/v1/object/sign/protected-app/app.js?token=fake",
      );
      return response.status;
    });

    expect(status).not.toBe(200);
  });

  test("the wrong password is rejected and does not reveal the right one", async ({
    page,
    state,
  }) => {
    await signIn(page, state);
    await page.goto("./");

    await page.getByLabel(/access password/i).fill("definitely-wrong");
    await page.getByRole("button", { name: /unlock/i }).click();

    await expect(page.getByRole("alert")).toBeVisible();
    expect(state.hasAccess).toBe(false);

    // Nothing anywhere in the delivered page may contain the real value.
    const content = await page.content();
    expect(content).not.toContain(state.correctPassword);
    const scripts = await page.evaluate(async () => {
      const out: string[] = [];
      for (const s of Array.from(document.querySelectorAll("script[src]"))) {
        const src = (s as HTMLScriptElement).src;
        if (src.startsWith("blob:") || src.includes("/assets/")) {
          out.push(await (await fetch(src)).text());
        }
      }
      return out.join("\n");
    });
    expect(scripts).not.toContain(state.correctPassword);
  });

  test("rate limiting engages after five failures", async ({ page, state }) => {
    await signIn(page, state);
    await page.goto("./");

    for (let attempt = 1; attempt <= 5; attempt++) {
      await page.getByLabel(/access password/i).fill(`wrong-${attempt}`);
      await page.getByRole("button", { name: /unlock/i }).click();
      await expect(page.getByRole("alert")).toBeVisible();
    }

    await page.getByLabel(/access password/i).fill("wrong-6");
    await page.getByRole("button", { name: /unlock/i }).click();
    await expect(page.getByRole("alert")).toContainText(/too many attempts/i);

    // Even the correct password is refused while the window is open.
    await page.getByLabel(/access password/i).fill(state.correctPassword);
    await page.getByRole("button", { name: /unlock/i }).click();
    await expect(page.locator("#editor-root")).toHaveCount(0);
  });
});

test.describe("the authorised path works", () => {
  test("the correct password unlocks and the verified bundle runs", async ({ page, state }) => {
    await signIn(page, state);
    await page.goto("./");

    await page.getByLabel(/access password/i).fill(state.correctPassword);
    await page.getByRole("button", { name: /unlock/i }).click();

    await expect(page.locator("#editor-root")).toHaveText("EDITOR LOADED", { timeout: 15_000 });
    expect(state.hasAccess).toBe(true);
  });

  test("an already granted user goes straight to the editor", async ({ page, state }) => {
    await signIn(page, state);
    state.hasAccess = true;
    state.grantExpiresAt = new Date(Date.now() + 3_600_000).toISOString();

    await page.goto("./");
    await expect(page.locator("#editor-root")).toHaveText("EDITOR LOADED", { timeout: 15_000 });
  });

  test("an expired grant sends the user back to the password form", async ({ page, state }) => {
    await signIn(page, state);
    state.hasAccess = false;
    state.grantExpiresAt = new Date(Date.now() - 1000).toISOString();

    await page.goto("./");
    await expect(page.getByLabel(/access password/i)).toBeVisible();
    await expect(page.locator("#editor-root")).toHaveCount(0);
  });

  test("a revoked grant stops the editor from loading on the next visit", async ({
    page,
    state,
  }) => {
    await signIn(page, state);
    state.hasAccess = true;
    state.grantExpiresAt = new Date(Date.now() + 3_600_000).toISOString();
    await page.goto("./");
    await expect(page.locator("#editor-root")).toHaveText("EDITOR LOADED", { timeout: 15_000 });

    state.hasAccess = false; // the owner revoked it server-side
    await page.reload();
    await expect(page.getByLabel(/access password/i)).toBeVisible();
    await expect(page.locator("#editor-root")).toHaveCount(0);
  });
});

test.describe("bundle integrity", () => {
  test("tampered bytes are refused and nothing executes", async ({ page, state }) => {
    await signIn(page, state);
    state.hasAccess = true;
    state.grantExpiresAt = new Date(Date.now() + 3_600_000).toISOString();
    state.tamper = true;

    await page.goto("./");

    await expect(page.getByRole("heading", { name: /refused to start/i })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator("#editor-root")).toHaveCount(0);
  });
});

test.describe("GitHub Pages base path", () => {
  test("the app is served under /LaTeXRenderer/ and its assets resolve", async ({ page }) => {
    const failures: string[] = [];
    page.on("response", (r) => {
      if (r.status() >= 400 && r.url().includes("/LaTeXRenderer/")) failures.push(r.url());
    });
    await page.goto("./");
    await expect(page.getByRole("button", { name: /continue with google/i })).toBeVisible();
    expect(failures).toEqual([]);
  });

  test("a direct deep link still renders the app instead of a 404 page", async ({ page }) => {
    // GitHub Pages serves 404.html for unknown paths; the build copies index.html there.
    const response = await page.goto("./some/deep/route");
    expect(response?.status()).toBeLessThan(500);
    await expect(page.getByRole("button", { name: /continue with google/i })).toBeVisible();
  });

  test("a refresh after the OAuth redirect does not 404", async ({ page }) => {
    await page.goto("./?code=fake-pkce-code&state=abc");
    await expect(page.getByRole("button", { name: /continue with google/i })).toBeVisible();
    // The code must be stripped so a copied URL carries no authorization state.
    expect(page.url()).not.toContain("code=");
  });
});

test.describe("no forbidden material reaches the browser", () => {
  test("the delivered JavaScript contains no service-role key or client secret", async ({
    page,
  }) => {
    await page.goto("./");
    const source = await page.evaluate(async () => {
      const parts: string[] = [];
      for (const s of Array.from(document.querySelectorAll("script[src]"))) {
        parts.push(await (await fetch((s as HTMLScriptElement).src)).text());
      }
      return parts.join("\n");
    });

    // Match credential *shapes*, not the words. The literal string "service_role" does
    // legitimately appear in src/config.ts, inside the guard that refuses to start when
    // someone pastes a service-role key into the publishable slot. Asserting on the bare
    // word would fail on the very code that prevents the leak.
    expect(source, "a JWT carrying role=service_role").not.toMatch(
      /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]*?service_role[A-Za-z0-9_-]*?\.[A-Za-z0-9_-]+/,
    );
    expect(source, "a Supabase secret key").not.toMatch(/\bsb_secret_[A-Za-z0-9_-]{10,}/);
    expect(source, "a Google OAuth client secret").not.toMatch(/\bGOCSPX-[A-Za-z0-9_-]{10,}/);
    expect(source, "PBKDF2 material").not.toMatch(
      /SITE_PASSWORD_(?:HASH|SALT)_B64\s*[=:]\s*["'`]?[A-Za-z0-9+/]{20,}/,
    );
    expect(source, "an assigned service-role key").not.toMatch(
      /SUPABASE_SERVICE_ROLE_KEY\s*[=:]\s*["'][^"']{20,}/,
    );
    expect(source, "a private key block").not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  });
});

test.describe("accessibility and responsiveness", () => {
  test("the landing page is keyboard reachable", async ({ page }) => {
    await page.goto("./");
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => document.activeElement?.textContent ?? "");
    expect(focused.length).toBeGreaterThan(0);
  });

  test("the page does not scroll horizontally on a narrow viewport", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("./");
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflows).toBe(false);
  });
});
