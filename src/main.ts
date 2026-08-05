/**
 * UnderRock public shell.
 *
 * Served from GitHub Pages, so every byte of it is public. It holds no secret and, in
 * Supabase mode, makes no authorisation decision of its own.
 *
 * Two modes, chosen automatically by src/config.ts:
 *
 *   DIRECT    Google sign-in happens in the browser; the editor is served from this same
 *             site. Nothing external to configure beyond a Google Client ID. There is no
 *             server, so there is no server-enforced gate -- see docs/SECURITY_MODEL.md.
 *
 *   SUPABASE  Sign-in via Supabase Auth (PKCE), then a server-checked shared-password
 *             gate, then the editor from a private bucket behind five-minute signed URLs.
 *
 * Both modes verify the SHA-256 of every asset before executing it.
 */

import "./styles.css";
import { config, FUNCTIONS } from "./config";
import {
  callFunction,
  currentSession,
  signInWithGoogle,
  signOut,
  supabase,
} from "./lib/supabase";
import {
  clearSession,
  loadGis,
  promptOneTap,
  renderSignInButton,
  storedSession,
  type GoogleProfile,
} from "./lib/googleAuth";
import {
  IntegrityError,
  clearProtectedAppCache,
  localManifest,
  startProtectedApp,
  stopProtectedApp,
  type ProtectedManifest,
} from "./lib/protectedApp";
import { mount } from "./lib/dom";
import {
  GOOGLE_BUTTON_ID,
  errorView,
  landingView,
  loadingView,
  lockedOutView,
  notConfiguredView,
  passwordView,
  progressView,
} from "./views";

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

const DIRECT = config.mode === "direct";
let appRunning = false;

function render(node: HTMLElement): void {
  if (appRunning) return; // never paint over a running editor
  mount(root as HTMLElement, node);
}

// ---------------------------------------------------------------------------
// landing
// ---------------------------------------------------------------------------

function showLanding(error?: string | null): void {
  render(landingView({ onSignIn: () => void beginSignIn() }, error, { renderGoogleButton: DIRECT }));

  if (!DIRECT) return;

  // Let Google draw its own button into the slot the view reserved. Google's branding
  // rules require their button, and the popup will not open reliably from a synthetic click.
  const host = document.getElementById(GOOGLE_BUTTON_ID);
  if (!host) return;
  void renderSignInButton(host, (profile, signInError) => {
    if (profile) void afterDirectSignIn(profile);
    else if (signInError) showLanding(signInError);
  }).catch((err: unknown) => {
    // The fallback button underneath still works, so this is informational.
    console.warn("Google button could not render:", err);
  });

  void promptOneTap((profile) => {
    if (profile) void afterDirectSignIn(profile);
  });
}

async function beginSignIn(): Promise<void> {
  if (!DIRECT) {
    render(loadingView("Redirecting to Google"));
    const { error } = await signInWithGoogle();
    if (error) showLanding(error);
    return;
  }

  // Direct mode: the popup must come from Google's own button. If the visitor clicked the
  // fallback, re-render so Google can draw it, and say why.
  try {
    await loadGis();
    showLanding("Use the Google button above to continue.");
  } catch (err) {
    showLanding(err instanceof Error ? err.message : String(err));
  }
}

async function afterDirectSignIn(profile: GoogleProfile): Promise<void> {
  render(loadingView(`Signed in as ${profile.email}`));
  await openWorkspace();
}

// ---------------------------------------------------------------------------
// sign out
// ---------------------------------------------------------------------------

async function doSignOut(): Promise<void> {
  render(loadingView("Signing out"));
  if (!DIRECT) {
    try {
      await callFunction(FUNCTIONS.revokeAccess);
    } catch {
      /* Signing out must succeed even if the network does not. */
    }
  }
  await stopProtectedApp();
  clearSession();
  if (!DIRECT) await signOut();
  // A reload is what actually reclaims whatever the editor bundle left behind.
  location.replace(config.basePath);
}

// ---------------------------------------------------------------------------
// password gate (Supabase mode only)
// ---------------------------------------------------------------------------

interface AccessState {
  hasAccess: boolean;
  expiresAt: string | null;
}

async function submitPassword(email: string, password: string): Promise<void> {
  render(passwordView(email, { onSubmit: () => {}, onSignOut: doSignOut }, { busy: true }));

  const { status, error } = await callFunction<{ ok: boolean; expiresAt: string }>(
    FUNCTIONS.verifyPassword,
    { password },
  );

  if (status === 200) {
    await openWorkspace();
    return;
  }

  if (status === 429) {
    render(
      passwordView(email, { onSubmit: (p) => submitPassword(email, p), onSignOut: doSignOut }, {
        lockedMinutes: 15,
      }),
    );
    return;
  }

  if (status === 401 && !(await currentSession())) {
    showLanding("Your session expired. Please sign in again.");
    return;
  }

  render(
    passwordView(email, { onSubmit: (p) => submitPassword(email, p), onSignOut: doSignOut }, {
      error: error ?? "That password was not accepted.",
    }),
  );
}

// ---------------------------------------------------------------------------
// workspace
// ---------------------------------------------------------------------------

async function resolveManifest(): Promise<
  { ok: true; manifest: ProtectedManifest } | { ok: false; node: HTMLElement }
> {
  if (DIRECT) {
    try {
      return { ok: true, manifest: await localManifest(config.basePath) };
    } catch (err) {
      return {
        ok: false,
        node: errorView("Editor not found", err instanceof Error ? err.message : String(err), {
          onRetry: openWorkspace,
          onSignOut: doSignOut,
        }),
      };
    }
  }

  const call = await callFunction<ProtectedManifest>(FUNCTIONS.getApp);
  if (call.status === 403) return { ok: false, node: lockedOutView(null, doSignOut) };
  if (call.status === 503) {
    return {
      ok: false,
      node: errorView(
        "Nothing published yet",
        "The editor has not been uploaded to this Supabase project.\n\n" +
          "Run the “Publish protected app” workflow in texCompiler.\n" +
          "See docs/DEPLOYMENT.md.",
        { onRetry: openWorkspace, onSignOut: doSignOut },
      ),
    };
  }
  if (!call.data) {
    return {
      ok: false,
      node: errorView("Could not start", call.error ?? "Unknown error.", {
        onRetry: openWorkspace,
        onSignOut: doSignOut,
      }),
    };
  }
  return { ok: true, manifest: call.data };
}

async function openWorkspace(): Promise<void> {
  render(loadingView("Opening your workspace"));

  const resolved = await resolveManifest();
  if (!resolved.ok) {
    render(resolved.node);
    return;
  }

  const manifest = resolved.manifest;

  // Hand the editor this deployment's Google Client ID so "Connect Drive" works out of the
  // box. It is only a default -- Settings lets each person substitute their own, which is
  // what removes the ten-test-user cap from Drive. See docs/GOOGLE_SETUP.md section B.
  (window as unknown as Record<string, unknown>).__UNDERROCK_GOOGLE_CLIENT_ID__ =
    config.googleClientId;
  (window as unknown as Record<string, unknown>).__UNDERROCK_MODE__ = config.mode;

  render(progressView("Verifying the application", 0, manifest.assets.length));

  try {
    await startProtectedApp(manifest, {
      onProgress: (done, total, path) => render(progressView(path, done, total)),
    });
    appRunning = true;
    // The editor takes over the page from here.
    root!.replaceChildren();
    root!.removeAttribute("aria-live");
  } catch (err) {
    appRunning = false;
    await stopProtectedApp();
    if (err instanceof IntegrityError) {
      render(
        errorView(
          "Refused to start",
          `${err.message}\n\n` +
            "The files do not match the fingerprints published for them. UnderRock will not\n" +
            "execute code it cannot verify. Reload to try again; if it keeps happening, the\n" +
            "deployment is damaged.",
          { onRetry: () => location.reload(), onSignOut: doSignOut },
        ),
      );
      return;
    }
    render(
      errorView("Could not start", err instanceof Error ? err.message : String(err), {
        onRetry: openWorkspace,
        onSignOut: doSignOut,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  if (!config.configured) {
    render(notConfiguredView(config.configError ?? "Configuration is incomplete."));
    return;
  }

  render(loadingView("Starting up"));

  if (DIRECT) {
    if (storedSession()) {
      await openWorkspace();
      return;
    }
    showLanding();
    return;
  }

  // ---- Supabase mode -------------------------------------------------------
  const session = await currentSession();
  if (location.search.includes("code=") || location.hash.includes("access_token")) {
    // Strip the PKCE code so a copied URL carries no authorisation state.
    history.replaceState({}, "", config.basePath);
  }

  if (!session) {
    showLanding();
    return;
  }

  const access = await callFunction<AccessState>(FUNCTIONS.checkAccess);

  if (access.status === 401) {
    await signOut();
    showLanding("Your session expired. Please sign in again.");
    return;
  }
  if (!access.data) {
    render(
      errorView("Could not reach the server", access.error ?? "Unknown error.", {
        onRetry: boot,
        onSignOut: doSignOut,
      }),
    );
    return;
  }

  if (!access.data.hasAccess) {
    // A lapsed grant means the cached bundle must go as well.
    await clearProtectedAppCache();
    const email = session.user.email ?? "your Google account";
    render(
      passwordView(email, {
        onSubmit: (password) => submitPassword(email, password),
        onSignOut: doSignOut,
      }),
    );
    return;
  }

  await openWorkspace();
}

// React to sign-out happening in another tab.
if (!DIRECT) {
  supabase().auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT" && appRunning) location.replace(config.basePath);
  });
}

// The editor asks the shell to end the session through these events rather than importing
// shell code, which keeps the two bundles independent.
window.addEventListener("underrock:sign-out", () => void doSignOut());
window.addEventListener("underrock:lock", () => {
  void (async () => {
    if (!DIRECT) await callFunction(FUNCTIONS.revokeAccess);
    await stopProtectedApp();
    clearSession();
    location.replace(config.basePath);
  })();
});

void boot();
