import { test as base, type Page, type Route } from "@playwright/test";

export const SUPABASE_HOST = "https://e2etest.supabase.co";

export interface ServerState {
  /** null means "nobody is signed in". */
  session: { access_token: string; email: string } | null;
  hasAccess: boolean;
  grantExpiresAt: string | null;
  /** Failed password attempts already recorded for this user. */
  failures: number;
  /** What the server considers correct. The browser never learns this value. */
  correctPassword: string;
  /** Assets the protected-app endpoint will offer, keyed by path. */
  bundle: Record<string, string>;
  /** Set to true to serve bytes that do not match the published hashes. */
  tamper: boolean;
  /** Every request path the browser attempted, for assertions. */
  calls: string[];
}

export function freshState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    session: null,
    hasAccess: false,
    grantExpiresAt: null,
    failures: 0,
    correctPassword: "e2e-correct-horse",
    bundle: {
      "app.js":
        "(function(){var d=document.createElement('div');d.id='editor-root';" +
        "d.textContent='EDITOR LOADED';document.body.appendChild(d);})();",
      "app.css": "#editor-root{color:green}",
    },
    tamper: false,
    calls: [],
    ...overrides,
  };
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(route: Route, status: number, body: unknown) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(body),
  });
}

/**
 * Stands in for Supabase.
 *
 * Crucially this mock enforces authorization exactly the way the real backend does: the
 * password is compared here, on the "server" side of the boundary, and no response ever
 * contains it. A test that manufactures access purely in the browser therefore fails,
 * which is the whole point of the security suite.
 */
export async function mockSupabase(page: Page, state: ServerState): Promise<void> {
  await page.route(`${SUPABASE_HOST}/**`, async (route) => {
    const url = new URL(route.request().url());
    state.calls.push(url.pathname);

    if (route.request().method() === "OPTIONS") {
      return route.fulfill({
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        },
      });
    }

    const authed = Boolean(state.session);

    if (url.pathname.endsWith("/functions/v1/check-site-access")) {
      if (!authed) return json(route, 401, { hasAccess: false });
      return json(route, 200, {
        hasAccess: state.hasAccess,
        expiresAt: state.grantExpiresAt,
      });
    }

    if (url.pathname.endsWith("/functions/v1/verify-site-password")) {
      if (!authed) return json(route, 401, { ok: false, error: "Access denied." });
      if (state.failures >= 5) {
        return json(route, 429, { ok: false, error: "Access denied.", retryAfterMinutes: 15 });
      }
      const body = route.request().postDataJSON() as { password?: string };
      if (body?.password !== state.correctPassword) {
        state.failures += 1;
        return json(route, 401, { ok: false, error: "Access denied." });
      }
      state.failures = 0;
      state.hasAccess = true;
      state.grantExpiresAt = new Date(Date.now() + 12 * 3600 * 1000).toISOString();
      return json(route, 200, { ok: true, expiresAt: state.grantExpiresAt });
    }

    if (url.pathname.endsWith("/functions/v1/get-protected-app")) {
      if (!authed) return json(route, 401, { ok: false, error: "Access denied." });
      // The server refuses without a grant. No browser-side state can change this.
      if (!state.hasAccess) return json(route, 403, { ok: false, error: "Access denied." });

      const assets = [];
      for (const [path, content] of Object.entries(state.bundle)) {
        assets.push({
          path,
          sha256: await sha256Hex(content),
          size: new TextEncoder().encode(content).byteLength,
          contentType: path.endsWith(".css") ? "text/css" : "text/javascript",
          url: `${SUPABASE_HOST}/storage/v1/object/sign/protected-app/${path}?token=fake`,
        });
      }
      return json(route, 200, {
        ok: true,
        buildId: "e2ebuild",
        entry: "app.js",
        styles: Object.keys(state.bundle).filter((p) => p.endsWith(".css")),
        worker: null,
        expiresInSeconds: 300,
        grantExpiresAt: state.grantExpiresAt,
        assets,
      });
    }

    if (url.pathname.includes("/storage/v1/object/sign/protected-app/")) {
      if (!state.hasAccess) {
        return json(route, 400, { error: "Object not found" });
      }
      const path = url.pathname.split("/protected-app/")[1] ?? "";
      const content = state.bundle[path];
      if (content === undefined) return json(route, 404, { error: "not found" });
      return route.fulfill({
        status: 200,
        contentType: path.endsWith(".css") ? "text/css" : "text/javascript",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: state.tamper ? `${content}/*tampered*/` : content,
      });
    }

    if (url.pathname.endsWith("/functions/v1/revoke-site-access")) {
      state.hasAccess = false;
      state.grantExpiresAt = null;
      return json(route, 200, { ok: true, revoked: 1 });
    }

    if (url.pathname.includes("/auth/v1/logout")) {
      state.session = null;
      return json(route, 204, {});
    }

    return json(route, 404, { error: "unmocked endpoint" });
  });
}

/** Plants a Supabase session in localStorage the way the SDK stores one. */
export async function signIn(page: Page, state: ServerState, email = "tester@example.test") {
  state.session = { access_token: "e2e-access-token", email };
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key as string, value as string);
    },
    [
      "latexrenderer.auth",
      JSON.stringify({
        access_token: "e2e-access-token",
        token_type: "bearer",
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        refresh_token: "e2e-refresh-token",
        user: {
          id: "00000000-0000-4000-8000-000000000001",
          aud: "authenticated",
          role: "authenticated",
          email,
          app_metadata: { provider: "google" },
          user_metadata: { full_name: "E2E Tester" },
          created_at: new Date().toISOString(),
        },
      }),
    ],
  );
}

export const test = base.extend<{ state: ServerState }>({
  state: async ({ page }, use) => {
    const state = freshState();
    await mockSupabase(page, state);
    await use(state);
  },
});

export { expect } from "@playwright/test";
