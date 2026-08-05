/**
 * UnderRock public shell.
 *
 * This file is served from GitHub Pages, so every byte of it is public. It therefore
 * contains no secret, makes no authorization decision of its own, and cannot be tricked
 * into revealing the editor application. Its whole job is:
 *
 *   1. establish a Google session through Supabase Auth (PKCE),
 *   2. ask the server whether that user currently holds a site-access grant,
 *   3. if not, forward a password attempt to the server and let the server decide,
 *   4. once the server says yes, fetch the protected bundle, verify its hashes, run it.
 *
 * Editing the DOM, flipping a localStorage flag, or calling any function in here from the
 * console cannot manufacture a grant. Step 4 fails without one, because get-protected-app
 * checks the grant server-side before it will sign a single URL.
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
  IntegrityError,
  clearProtectedAppCache,
  startProtectedApp,
  stopProtectedApp,
  type ProtectedManifest,
} from "./lib/protectedApp";
import { mount } from "./lib/dom";
import {
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

let appRunning = false;

function render(node: HTMLElement): void {
  if (appRunning) return; // never paint over a running editor
  mount(root as HTMLElement, node);
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

async function doSignOut(): Promise<void> {
  render(loadingView("Signing out"));
  try {
    // Best effort: end the grant server-side too, so a shared machine cannot resume.
    await callFunction(FUNCTIONS.revokeAccess);
  } catch {
    /* Signing out must succeed even if the network does not. */
  }
  await stopProtectedApp();
  await signOut();
  // A reload is what actually reclaims whatever the editor bundle left behind.
  location.replace(config.basePath);
}

async function doSignIn(): Promise<void> {
  render(loadingView("Redirecting to Google"));
  const { error } = await signInWithGoogle();
  if (error) {
    render(landingView({ onSignIn: doSignIn }, error));
  }
}

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

  if (status === 401) {
    // Deliberately vague: the server returns one body for wrong-password and for
    // not-signed-in, and the shell does not invent a more specific message.
    const session = await currentSession();
    if (!session) {
      render(landingView({ onSignIn: doSignIn }, "Your session expired. Please sign in again."));
      return;
    }
  }

  render(
    passwordView(email, { onSubmit: (p) => submitPassword(email, p), onSignOut: doSignOut }, {
      error: error ?? "That password was not accepted.",
    }),
  );
}

async function openWorkspace(): Promise<void> {
  render(loadingView("Checking your access"));

  const manifestCall = await callFunction<ProtectedManifest>(FUNCTIONS.getApp);

  if (manifestCall.status === 403) {
    render(lockedOutView(null, doSignOut));
    return;
  }
  if (manifestCall.status === 503) {
    render(
      errorView(
        "Nothing published yet",
        "The editor application has not been uploaded to this Supabase project.\n\n" +
          "The site owner needs to run the “Publish protected app” workflow in the\n" +
          "texCompiler repository. See docs/DEPLOYMENT.md.",
        { onRetry: openWorkspace, onSignOut: doSignOut },
      ),
    );
    return;
  }
  if (!manifestCall.data) {
    render(
      errorView("Could not start", manifestCall.error ?? "Unknown error.", {
        onRetry: openWorkspace,
        onSignOut: doSignOut,
      }),
    );
    return;
  }

  const manifest = manifestCall.data;
  render(progressView("Verifying the application", 0, manifest.assets.length));

  try {
    await startProtectedApp(manifest, {
      onProgress: (done, total, path) => {
        render(progressView(path, done, total));
      },
    });
    appRunning = true;
    // The editor takes over the page from here. Clear the shell's own markup so the two
    // cannot fight over layout.
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
            "This means the files the server sent do not match the fingerprints it\n" +
            "published for them. UnderRock will not execute code it cannot verify.\n" +
            "Reload to try again; if it keeps happening, tell the site owner.",
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

  // detectSessionInUrl consumes the PKCE code, then the query string is stripped so a
  // copied URL cannot carry authorization state around.
  const session = await currentSession();
  if (location.search.includes("code=") || location.hash.includes("access_token")) {
    history.replaceState({}, "", config.basePath);
  }

  if (!session) {
    render(landingView({ onSignIn: doSignIn }));
    return;
  }

  const access = await callFunction<AccessState>(FUNCTIONS.checkAccess);

  if (access.status === 401) {
    await signOut();
    render(landingView({ onSignIn: doSignIn }, "Your session expired. Please sign in again."));
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
    // A grant that has lapsed means the cached bundle must go as well.
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
supabase().auth.onAuthStateChange((event) => {
  if (event === "SIGNED_OUT" && appRunning) {
    location.replace(config.basePath);
  }
});

// The editor asks the shell to end the session through this event rather than importing
// shell code, which keeps the two bundles independent.
window.addEventListener("underrock:sign-out", () => {
  void doSignOut();
});
window.addEventListener("underrock:lock", () => {
  void (async () => {
    await callFunction(FUNCTIONS.revokeAccess);
    await stopProtectedApp();
    location.replace(config.basePath);
  })();
});

void boot();
