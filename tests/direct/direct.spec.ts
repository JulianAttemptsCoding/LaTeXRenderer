import { expect, test, type Page } from "@playwright/test";

/**
 * Direct mode, against the real build and the real encrypted editor bundle.
 *
 * This is the configuration a visitor to
 * https://julianattemptscoding.github.io/LaTeXRenderer/ actually gets: sign in with
 * Google, then enter the shared password, which is the AES key the editor is encrypted
 * under. Everything after the seeded session is the genuine code path — envelope fetch,
 * PBKDF2, AES-GCM decrypt, SHA-256 check, blob execution, React mount.
 *
 * The password is read from SHARED_PASSWORD. It is never written into this repository,
 * and the tests that need it SKIP LOUDLY when it is absent rather than passing vacuously.
 *
 *   SHARED_PASSWORD=... npm run test:direct
 */

const SESSION_KEY = "underrock.google.session";
const UNLOCK_KEY = "underrock.unlock";
const PASSWORD = process.env.SHARED_PASSWORD ?? "";
const HAVE_PASSWORD = PASSWORD.length > 0;

/**
 * Puts the browser in the state Google Identity Services would leave it in.
 *
 * An explicit visit + evaluate rather than page.addInitScript, because an init script
 * re-runs on EVERY navigation — including the reload that sign-out performs, which would
 * silently re-create the session it had just cleared and make that test unfalsifiable.
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

/** Google's script is blocked so no test depends on a third-party network call. */
async function blockGoogle(page: Page) {
  await page.route("https://accounts.google.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: "/* blocked in tests */" }),
  );
}

async function unlock(page: Page, password: string) {
  await page.getByLabel(/access password/i).fill(password);
  await page.getByRole("button", { name: /unlock/i }).click();
}

test.describe("direct mode", () => {
  test.beforeEach(async ({ page }) => {
    await blockGoogle(page);
  });

  // -- the gate comes first, before anything else ----------------------------

  test("the very first thing a visitor sees is the password, not sign-in", async ({ page }) => {
    await page.goto("./");
    await expect(page.getByLabel(/access password/i)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("heading", { name: /enter the access password/i })).toBeVisible();
    // Identity comes after the gate, so there must be no Google button yet.
    await expect(page.getByRole("button", { name: /continue with google/i })).toHaveCount(0);
    await expect(page.locator("#underrock-root")).toHaveCount(0);
  });

  test("even with a signed-in session, the password is still demanded", async ({ page }) => {
    await seedSession(page);
    await page.goto("./");
    await expect(page.getByLabel(/access password/i)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("#underrock-root")).toHaveCount(0);
  });

  test("no Supabase call is attempted", async ({ page }) => {
    const calls: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes(".supabase.co")) calls.push(r.url());
    });
    await page.goto("./");
    await expect(page.getByLabel(/access password/i)).toBeVisible({ timeout: 30_000 });
    expect(calls).toEqual([]);
  });

  test("the plaintext editor is not reachable at all", async ({ page }) => {
    // The whole point of encrypting: there must be no unencrypted copy to fetch instead.
    //
    // Asserted on CONTENT, not status. `vite preview` has an SPA fallback that answers
    // unknown paths with index.html and a 200, so a status check would fail here while
    // passing on GitHub Pages, which returns a real 404 — the assertion would be testing
    // the dev server rather than the deployment.
    await page.goto("./");
    const results = await page.evaluate(async () => {
      const paths = ["./app/app.js", "./app/manifest.json", "./app.js", "./assets/app.js"];
      const out: Record<string, string> = {};
      for (const p of paths) {
        try {
          const r = await fetch(p, { cache: "no-store" });
          out[p] = r.ok ? (await r.text()).slice(0, 2000) : "";
        } catch {
          out[p] = "";
        }
      }
      return out;
    });

    for (const [path, body] of Object.entries(results)) {
      // Markers that only the real editor bundle or its manifest would carry.
      expect(body, `${path} served editor JavaScript`).not.toContain("underrock-root");
      expect(body, `${path} served editor JavaScript`).not.toContain("documentclass");
      expect(body, `${path} served a plaintext manifest`).not.toContain('"sha256"');
      expect(body, `${path} served a Monaco bundle`).not.toContain("monaco");
    }
  });

  test("the published ciphertext contains no recognisable JavaScript", async ({ page }) => {
    await page.goto("./");
    const probe = await page.evaluate(async () => {
      const r = await fetch("./app-locked/app.js.enc", { cache: "no-store" });
      const buf = new Uint8Array(await r.arrayBuffer());
      // Decode the first 4 KB as latin1 and look for anything that would betray the source.
      let head = "";
      for (let i = 0; i < Math.min(buf.length, 4096); i++) head += String.fromCharCode(buf[i]!);
      return { status: r.status, bytes: buf.length, head };
    });
    expect(probe.status).toBe(200);
    expect(probe.bytes).toBeGreaterThan(100000);
    expect(probe.head).not.toContain("function");
    expect(probe.head).not.toContain("underrock");
    expect(probe.head).not.toContain("documentclass");
  });

  test("a wrong password is refused and nothing executes", async ({ page }) => {
    await page.goto("./");
    await expect(page.getByLabel(/access password/i)).toBeVisible({ timeout: 30_000 });

    await unlock(page, "definitely-not-the-password");

    await expect(page.getByRole("alert")).toContainText(/not correct/i, { timeout: 60_000 });
    await expect(page.locator("#underrock-root")).toHaveCount(0);
    // It must also not have advanced to sign-in: a wrong password gets you nowhere.
    await expect(page.getByRole("button", { name: /continue with google/i })).toHaveCount(0);
    // And it must not leave a usable key behind.
    const cached = await page.evaluate((k) => sessionStorage.getItem(k), UNLOCK_KEY);
    expect(cached).toBeNull();
  });

  test("the envelope never contains the password or the key", async ({ page }) => {
    await page.goto("./");
    const envelope = await page.evaluate(async () =>
      (await fetch("./app-locked/envelope.json", { cache: "no-store" })).text(),
    );
    expect(envelope).toContain("PBKDF2");
    expect(envelope).toContain("AES-256-GCM");
    // Salt and iteration count are public by design; a key or password would not be.
    expect(envelope.toLowerCase()).not.toContain("password");
    expect(JSON.parse(envelope).kdf.iterations).toBeGreaterThanOrEqual(310000);
  });

  // -- past the gate ---------------------------------------------------------

  test.describe("with the correct password", () => {
    test.skip(
      !HAVE_PASSWORD,
      "SHARED_PASSWORD is not set, so the unlock path cannot be exercised. " +
        "Run: SHARED_PASSWORD=... npm run test:direct",
    );

    test("the correct password, with no session, leads to Google sign-in", async ({ page }) => {
      // The order the owner asked for: password -> Google -> editor.
      await page.goto("./");
      await expect(page.getByLabel(/access password/i)).toBeVisible({ timeout: 30_000 });
      await unlock(page, PASSWORD);

      await expect(page.getByRole("heading", { name: /make latex free and open/i })).toBeVisible({
        timeout: 60_000,
      });
      await expect(page.getByRole("button", { name: /continue with google/i })).toBeVisible();
      // Unlocked, but not signed in, so still no editor.
      await expect(page.locator("#underrock-root")).toHaveCount(0);
      // The key is cached, so a reload must not ask for the password again.
      expect(await page.evaluate((k) => sessionStorage.getItem(k), UNLOCK_KEY)).not.toBeNull();
    });

    test("the correct password with a session decrypts and starts the editor", async ({
      page,
    }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (e) => pageErrors.push(e.message));

      await seedSession(page);
      await page.goto("./");
      await expect(page.getByLabel(/access password/i)).toBeVisible({ timeout: 30_000 });

      await unlock(page, PASSWORD);

      await expect(page.locator("#underrock-root .dashboard")).toBeVisible({ timeout: 90_000 });
      await expect(page.getByRole("button", { name: /new blank project/i })).toBeVisible();

      const fatal = pageErrors.filter((m) =>
        /Failed to (fetch|resolve)|Cannot use import statement|Unexpected token 'export'/i.test(m),
      );
      expect(fatal, `module errors: ${fatal.join(" | ")}`).toEqual([]);
    });

    test("the editor receives the account and the Google Client ID", async ({ page }) => {
      await seedSession(page, "someone@example.test");
      await page.goto("./");
      await unlock(page, PASSWORD);
      await expect(page.locator("#underrock-root .dashboard")).toBeVisible({ timeout: 90_000 });

      const handoff = await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        return {
          clientId: String(w.__UNDERROCK_GOOGLE_CLIENT_ID__ ?? ""),
          mode: w.__UNDERROCK_MODE__,
          account: w.__UNDERROCK_ACCOUNT__ as { email?: string } | undefined,
        };
      });
      expect(handoff.clientId).toMatch(/\.apps\.googleusercontent\.com$/);
      expect(handoff.mode).toBe("direct");
      expect(handoff.account?.email).toBe("someone@example.test");
    });

    test("the account record persists on this device", async ({ page }) => {
      await seedSession(page, "persist@example.test");
      await page.goto("./");
      await unlock(page, PASSWORD);
      await expect(page.locator("#underrock-root .dashboard")).toBeVisible({ timeout: 90_000 });

      const record = await page.evaluate(() => {
        const sub = localStorage.getItem("underrock.account.current");
        return sub ? JSON.parse(localStorage.getItem(`underrock.account.${sub}`) ?? "null") : null;
      });
      expect(record?.email).toBe("persist@example.test");
      expect(record?.firstSeenAt).toBeTruthy();
    });

    test("a reload in the same tab does not ask again", async ({ page }) => {
      await seedSession(page);
      await page.goto("./");
      await unlock(page, PASSWORD);
      await expect(page.locator("#underrock-root .dashboard")).toBeVisible({ timeout: 90_000 });

      await page.reload();
      await expect(page.locator("#underrock-root .dashboard")).toBeVisible({ timeout: 90_000 });
      await expect(page.getByLabel(/access password/i)).toHaveCount(0);
    });

    test("a new project can be created and edited", async ({ page }) => {
      await seedSession(page);
      await page.goto("./");
      await unlock(page, PASSWORD);
      await expect(page.locator("#underrock-root .dashboard")).toBeVisible({ timeout: 90_000 });

      page.once("dialog", (dialog) => void dialog.accept("QA smoke project"));
      await page.getByRole("button", { name: /new blank project/i }).click();

      await expect(page.locator("#underrock-root .workspace")).toBeVisible({ timeout: 30_000 });
      await expect(page.locator(".topbar .project-name")).toHaveText("QA smoke project");
      await expect(page.locator('[data-testid="monaco-host"]')).toBeVisible({ timeout: 30_000 });

      // On a narrow screen only one pane fits, so the tree lives behind the switcher.
      const switcher = page.locator(".mobile-switch");
      if (await switcher.isVisible()) {
        await switcher.getByRole("button", { name: "Files" }).click();
      }
      await expect(page.locator(".file-tree")).toBeVisible();
    });

    test("signing out clears the session AND the unlock key", async ({ page }) => {
      await seedSession(page);
      await page.goto("./");
      await unlock(page, PASSWORD);
      await expect(page.locator("#underrock-root .dashboard")).toBeVisible({ timeout: 90_000 });

      await page.evaluate(() => window.dispatchEvent(new CustomEvent("underrock:sign-out")));

      // Both gates re-arm: signing out drops the unlock key too, so the password is the
      // first thing demanded again -- not the Google button.
      await expect(page.getByLabel(/access password/i)).toBeVisible({ timeout: 30_000 });
      const state = await page.evaluate(
        ([s, u]) => ({
          session: localStorage.getItem(s as string),
          unlock: sessionStorage.getItem(u as string),
        }),
        [SESSION_KEY, UNLOCK_KEY],
      );
      expect(state.session).toBeNull();
      expect(state.unlock).toBeNull();
    });

    test("when Google refuses the origin, the page says exactly what to fix", async ({ page }) => {
      // Reproduces the "Error 401: invalid_client / no registered origin" case by blocking
      // Google's script, which leaves the same empty button slot.
      await page.goto("./");
      await unlock(page, PASSWORD);
      await expect(page.getByRole("button", { name: /continue with google/i })).toBeVisible({
        timeout: 60_000,
      });
      const alert = page.getByRole("alert");
      await expect(alert).toBeVisible({ timeout: 20_000 });
      await expect(alert).toContainText(/authorised javascript origins/i);
      await expect(page.locator(".origin-value")).toHaveText("http://localhost:4174");
    });

    test("lock keeps you signed in but demands the password again", async ({ page }) => {
      await seedSession(page);
      await page.goto("./");
      await unlock(page, PASSWORD);
      await expect(page.locator("#underrock-root .dashboard")).toBeVisible({ timeout: 90_000 });

      await page.evaluate(() => window.dispatchEvent(new CustomEvent("underrock:lock")));

      await expect(page.getByLabel(/access password/i)).toBeVisible({ timeout: 30_000 });
      const session = await page.evaluate((k) => localStorage.getItem(k), SESSION_KEY);
      expect(session, "lock must not sign you out of Google").not.toBeNull();
    });

    test("tampered ciphertext is refused even with the right password", async ({ page }) => {
      await seedSession(page);
      await page.route("**/app-locked/app.js.enc", async (route) => {
        const response = await route.fetch();
        const body = Buffer.from(await response.body());
        // Flip one byte inside the ciphertext. AES-GCM must fail the tag check.
        const at = Math.floor(body.length / 2);
        body[at] = (body[at] ?? 0) ^ 0x01;
        await route.fulfill({ status: 200, body });
      });

      await page.goto("./");
      await expect(page.getByLabel(/access password/i)).toBeVisible({ timeout: 30_000 });
      await unlock(page, PASSWORD);

      // Reported as a bad password, because a failed GCM tag is indistinguishable from one.
      await expect(page.getByRole("alert")).toBeVisible({ timeout: 90_000 });
      await expect(page.locator("#underrock-root")).toHaveCount(0);
    });
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
    expect(source, "a Google client secret").not.toMatch(/\bGOCSPX-[A-Za-z0-9_-]{10,}/);
    expect(source, "a service-role JWT").not.toMatch(
      /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]*service_role/,
    );
    expect(source, "a Supabase secret key").not.toMatch(/\bsb_secret_[A-Za-z0-9_-]{10,}/);
  });

  test("the shell bundle does not contain the shared password", async ({ page }) => {
    test.skip(!HAVE_PASSWORD, "SHARED_PASSWORD is not set, so this cannot be checked.");
    await page.goto("./");
    const source = await page.evaluate(async () => {
      const parts: string[] = [];
      for (const s of Array.from(document.querySelectorAll("script[src]"))) {
        const src = (s as HTMLScriptElement).src;
        if (src.startsWith("http")) parts.push(await (await fetch(src)).text());
      }
      return parts.join("\n");
    });
    expect(source).not.toContain(PASSWORD);
  });
});
