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
  WrongPasswordError,
  cacheUnlockKey,
  cachedUnlockKey,
  clearProtectedAppCache,
  clearUnlockKey,
  deriveUnlockKey,
  fetchEnvelope,
  localManifest,
  startProtectedApp,
  stopProtectedApp,
  unlockManifest,
  type LockedEnvelope,
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
    if (profile) {
      void afterDirectSignIn(profile);
      return;
    }
    if (!signInError) return;
    // "invalid_client" / "no registered origin" means the OAuth client does not list this
    // page's origin. Google reports it in its own popup, so without this the user is
    // bounced back to a landing page that looks fine and explains nothing.
    if (/invalid_client|origin|unregistered|401/i.test(signInError)) {
      showLanding();
      const slot = document.getElementById(GOOGLE_BUTTON_ID);
      if (slot) renderOriginHelp(slot, signInError);
      return;
    }
    showLanding(signInError);
  })
    .then(() => {
      // Google refuses to render, silently, when the page's origin is not on the OAuth
      // client's authorised-origins list. That is by far the most likely first-run
      // failure, and without this check it presents as a button that simply is not there.
      // Detect the empty slot and say exactly what to fix.
      window.setTimeout(() => {
        if (host.isConnected && host.childElementCount === 0) {
          renderOriginHelp(host);
        }
      }, 2500);
    })
    .catch((err: unknown) => {
      console.warn("Google button could not render:", err);
      if (host.isConnected) renderOriginHelp(host, err instanceof Error ? err.message : undefined);
    });

  void promptOneTap((profile) => {
    if (profile) void afterDirectSignIn(profile);
  });
}

/**
 * Shown when Google declines to draw its button.
 *
 * Almost always means the OAuth client does not list this exact origin. The message gives
 * the value to paste and where to paste it, rather than a generic failure.
 */
function renderOriginHelp(host: HTMLElement, detail?: string): void {
  const origin = location.origin;
  const box = document.createElement("div");
  box.className = "alert alert-error";
  box.setAttribute("role", "alert");

  const line = (text: string, cls = "") => {
    const p = document.createElement("p");
    if (cls) p.className = cls;
    p.textContent = text;
    return p;
  };

  box.appendChild(line("Google would not show its sign-in button."));
  box.appendChild(
    line(
      "This nearly always means the OAuth client does not list this site's origin. " +
        "Add this exact value under “Authorised JavaScript origins”, with no path and no " +
        "trailing slash:",
      "small",
    ),
  );

  const code = document.createElement("code");
  code.className = "origin-value";
  code.textContent = origin;
  box.appendChild(code);

  const link = document.createElement("a");
  link.href = "https://console.cloud.google.com/apis/credentials";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "Open Google Cloud credentials";
  const linkWrap = line("", "small");
  linkWrap.appendChild(link);
  box.appendChild(linkWrap);

  box.appendChild(
    line("Changes can take a few minutes to take effect. Reload after saving.", "small"),
  );
  if (detail) box.appendChild(line(detail, "small"));

  host.replaceChildren(box);
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
  rememberAccount(profile);
  render(loadingView(`Signed in as ${profile.email}`));
  // The password was supplied before sign-in, so the key is already cached; go straight in.
  await boot();
}

/**
 * Keeps a per-Google-account record on this device.
 *
 * In direct mode there is no database, so "your account" is this record plus whatever the
 * editor stores under the same key: preferences, the local compiler token, the Drive
 * Client ID. Keyed by the Google subject id so two people sharing a browser do not
 * inherit each other's settings.
 */
function rememberAccount(profile: GoogleProfile): void {
  try {
    const key = `underrock.account.${profile.sub}`;
    const existing = JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, unknown>;
    localStorage.setItem(
      key,
      JSON.stringify({
        ...existing,
        sub: profile.sub,
        email: profile.email,
        name: profile.name,
        picture: profile.picture,
        firstSeenAt: existing.firstSeenAt ?? new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      }),
    );
    localStorage.setItem("underrock.account.current", profile.sub);
  } catch {
    /* Private browsing can refuse writes; the session still works, it just does not persist. */
  }
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
  clearUnlockKey(); // the next visitor must re-enter the shared password
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

// ---------------------------------------------------------------------------
// direct mode: the shared-password gate
// ---------------------------------------------------------------------------
//
// The editor is shipped encrypted (AES-256-GCM, key = PBKDF2-HMAC-SHA256 x310 000 of the
// shared password). There is no server here, so a password that were merely *checked* in
// JavaScript would be deleted by anyone who wanted in. Encrypting removes the thing to
// bypass: without the password there is no plaintext to run.
//
// Honest limit, stated in SECURITY_MODEL.md too: the ciphertext is public, so an attacker
// can brute-force offline. Strength is password entropy times KDF cost. Supabase mode is
// stronger because five wrong guesses per fifteen minutes is enforced somewhere the
// attacker does not control.

async function unlockAndRun(
  envelope: LockedEnvelope,
  key: CryptoKey,
): Promise<{ ok: true } | { ok: false; wrongPassword: boolean; message: string }> {
  try {
    render(progressView("Decrypting the application", 0, envelope.assets.length));
    const { manifest, plaintext } = await unlockManifest(
      envelope,
      key,
      config.basePath,
      (done, total, path) => render(progressView(path, done, total)),
    );

    handOffToApp(manifest);
    await startProtectedApp(manifest, {
      preloaded: plaintext,
      onProgress: (done, total, path) => render(progressView(path, done, total)),
    });
    appRunning = true;
    root!.replaceChildren();
    root!.removeAttribute("aria-live");
    return { ok: true };
  } catch (err) {
    appRunning = false;
    await stopProtectedApp();
    if (err instanceof WrongPasswordError) {
      return { ok: false, wrongPassword: true, message: err.message };
    }
    return {
      ok: false,
      wrongPassword: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Decrypts and starts the editor with an already-derived key, rendering any failure. */
async function runUnlocked(envelope: LockedEnvelope, key: CryptoKey): Promise<void> {
  const result = await unlockAndRun(envelope, key);
  if (result.ok) return;
  if (result.wrongPassword) {
    // A cached key that no longer works: the build changed, or storage was tampered with.
    clearUnlockKey();
    showPasswordGate(envelope);
    return;
  }
  render(
    errorView("Could not start", result.message, { onRetry: boot, onSignOut: doSignOut }),
  );
}

/**
 * The shared-password gate. Shown before anything else, including sign-in.
 *
 * On success the derived key is cached for the tab, then the flow moves to Google
 * sign-in — or straight into the editor if a session already exists.
 */
function showPasswordGate(
  envelope: LockedEnvelope,
  state: { error?: string | null; busy?: boolean } = {},
): void {
  const submit = async (password: string) => {
    showPasswordGate(envelope, { busy: true });
    // The derivation is deliberately slow; yield first so the busy state paints.
    await new Promise((r) => setTimeout(r, 16));

    let key: CryptoKey;
    try {
      key = await deriveUnlockKey(password, envelope);
    } catch (err) {
      showPasswordGate(envelope, {
        error: err instanceof Error ? err.message : "Could not use that password.",
      });
      return;
    }

    // Prove the key before caching it: decrypt one asset and check the GCM tag. Caching
    // an unverified key would mean a wrong password appearing to succeed until the next
    // reload failed confusingly.
    render(loadingView("Unlocking"));
    try {
      await unlockManifest(envelope, key, config.basePath);
    } catch (err) {
      if (err instanceof WrongPasswordError) {
        showPasswordGate(envelope, { error: "That password is not correct." });
        return;
      }
      render(
        errorView("Could not start", err instanceof Error ? err.message : String(err), {
          onRetry: boot,
        }),
      );
      return;
    }

    await cacheUnlockKey(key, envelope.buildId);

    const profile = storedSession();
    if (!profile) {
      showLanding();
      return;
    }
    rememberAccount(profile);
    await runUnlocked(envelope, key);
  };

  render(
    passwordView(
      storedSession()?.email ?? null,
      { onSubmit: (password) => void submit(password), onSignOut: doSignOut },
      state,
    ),
  );
}

/** Values the editor reads out of the shell rather than importing shell code. */
function handOffToApp(manifest: ProtectedManifest): void {
  const w = window as unknown as Record<string, unknown>;
  w.__UNDERROCK_GOOGLE_CLIENT_ID__ = config.googleClientId;
  w.__UNDERROCK_MODE__ = config.mode;
  const profile = storedSession();
  if (profile) {
    w.__UNDERROCK_ACCOUNT__ = {
      sub: profile.sub,
      email: profile.email,
      name: profile.name,
      picture: profile.picture,
    };
  }
  void manifest;
}

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
  // Direct mode always re-enters through boot(), which enforces password-then-identity.
  if (DIRECT) return boot();

  render(loadingView("Opening your workspace"));

  const resolved = await resolveManifest();
  if (!resolved.ok) {
    render(resolved.node);
    return;
  }

  const manifest = resolved.manifest;
  handOffToApp(manifest);

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
    // ORDER: password first, then Google, then the editor.
    //
    // The password gates the whole site, so it is asked before anything else -- including
    // before sign-in. That is also the honest order: the password is the decryption key,
    // so until it is supplied there is genuinely nothing to show. Signing in first would
    // have implied the site was already open.
    let envelope: LockedEnvelope;
    try {
      envelope = await fetchEnvelope(config.basePath);
    } catch (err) {
      render(
        errorView("Editor not published", err instanceof Error ? err.message : String(err), {
          onRetry: boot,
        }),
      );
      return;
    }

    const key = await cachedUnlockKey(envelope.buildId);
    if (!key) {
      showPasswordGate(envelope);
      return;
    }

    // Past the password. Now identity.
    const profile = storedSession();
    if (!profile) {
      showLanding();
      return;
    }
    // Refreshed on a restored session too, not only a fresh sign-in, or lastSeenAt would
    // never move for anyone who signs in once and always returns with a live session.
    rememberAccount(profile);
    await runUnlocked(envelope, key);
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
    // Lock keeps you signed in to Google but demands the shared password again.
    clearUnlockKey();
    location.replace(config.basePath);
  })();
});

void boot();
