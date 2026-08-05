/**
 * Client-side Google sign-in, for direct mode.
 *
 * Uses Google Identity Services with the Client ID only. No client secret is involved --
 * a browser cannot keep one, and this flow does not need one.
 *
 * HONEST LIMITATION, stated here because it is the whole security story of direct mode:
 * the ID token Google returns is signed by Google, but nothing in this file *verifies*
 * that signature. Verification requires fetching Google's public keys and checking the
 * token server-side, and in direct mode there is no server. So the identity shown in the
 * interface is what Google told this browser, and a determined user could edit it in
 * local storage.
 *
 * That is acceptable here for exactly one reason: **nothing in direct mode trusts the
 * identity for authorisation.** Projects live in the user's own browser, their own folder,
 * or their own Google Drive -- and Drive access is granted by Google directly to that
 * user's own account, which *is* verified, by Google, at the point it matters. Forging a
 * local profile gets you a different name in the corner of the screen and access to
 * nothing you did not already have.
 *
 * When Supabase is configured, sign-in switches to Supabase Auth, which verifies the token
 * server-side and issues a real session. See docs/SECURITY_MODEL.md.
 */

import { config } from "../config";

const SESSION_KEY = "underrock.google.session";
const GIS_SRC = "https://accounts.google.com/gsi/client";

export interface GoogleProfile {
  sub: string;
  email: string;
  name: string;
  picture: string;
  /** Seconds since the epoch, from the token. */
  exp: number;
}

interface CredentialResponse {
  credential?: string;
  error?: string;
}

declare global {
  interface Window {
    google?: {
      accounts?: {
        id?: {
          initialize(config: {
            client_id: string;
            callback: (response: CredentialResponse) => void;
            auto_select?: boolean;
            cancel_on_tap_outside?: boolean;
            ux_mode?: "popup" | "redirect";
          }): void;
          renderButton(parent: HTMLElement, options: Record<string, unknown>): void;
          prompt(listener?: (notification: unknown) => void): void;
          disableAutoSelect(): void;
        };
      };
    };
  }
}

let gisPromise: Promise<void> | null = null;

export function loadGis(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (gisPromise) return gisPromise;

  gisPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>("script[data-gis]");
    const script = existing ?? document.createElement("script");
    if (!existing) {
      script.src = GIS_SRC;
      script.async = true;
      script.defer = true;
      script.dataset.gis = "1";
    }
    script.addEventListener("load", () => resolve());
    script.addEventListener("error", () =>
      reject(
        new Error(
          "Google's sign-in script could not load. Check your connection, and whether an " +
            "extension is blocking accounts.google.com.",
        ),
      ),
    );
    if (!existing) document.head.appendChild(script);
    // A script already in the DOM may have loaded before the listener attached.
    if (existing && window.google?.accounts?.id) resolve();
  });
  return gisPromise;
}

/** Base64url JWT payload decode. Does not, and cannot, verify the signature. */
function decodeIdToken(token: string): GoogleProfile | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(
      decodeURIComponent(
        Array.from(json)
          .map((c) => `%${`00${c.charCodeAt(0).toString(16)}`.slice(-2)}`)
          .join(""),
      ),
    ) as Record<string, unknown>;

    if (typeof payload.sub !== "string" || typeof payload.email !== "string") return null;
    return {
      sub: payload.sub,
      email: payload.email,
      name: typeof payload.name === "string" ? payload.name : payload.email,
      picture: typeof payload.picture === "string" ? payload.picture : "",
      exp: typeof payload.exp === "number" ? payload.exp : 0,
    };
  } catch {
    return null;
  }
}

export function storedSession(): GoogleProfile | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const profile = JSON.parse(raw) as GoogleProfile;
    // A token past its expiry is treated as no session at all.
    if (!profile?.sub || (profile.exp && profile.exp * 1000 < Date.now())) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return profile;
  } catch {
    return null;
  }
}

function storeSession(profile: GoogleProfile): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(profile));
  } catch {
    /* Private browsing can refuse writes; the session then lasts for this page only. */
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* nothing to do */
  }
  window.google?.accounts?.id?.disableAutoSelect();
}

let initialised = false;
let pending: ((profile: GoogleProfile | null, error: string | null) => void) | null = null;

async function ensureInitialised(): Promise<void> {
  await loadGis();
  const id = window.google?.accounts?.id;
  if (!id) throw new Error("Google Identity Services did not initialise. Reload and try again.");
  if (initialised) return;

  id.initialize({
    client_id: config.googleClientId,
    auto_select: false,
    cancel_on_tap_outside: true,
    ux_mode: "popup",
    callback: (response) => {
      if (response.error || !response.credential) {
        pending?.(null, response.error ?? "Google did not return a sign-in token.");
        pending = null;
        return;
      }
      const profile = decodeIdToken(response.credential);
      if (!profile) {
        pending?.(null, "Google returned a token this browser could not read.");
        pending = null;
        return;
      }
      storeSession(profile);
      pending?.(profile, null);
      pending = null;
    },
  });
  initialised = true;
}

/**
 * Renders Google's own sign-in button into `parent`.
 *
 * Google's rendered button is used rather than a custom one because Google's branding
 * rules require it, and because the popup flow will not open reliably from a synthetic
 * click.
 */
export async function renderSignInButton(
  parent: HTMLElement,
  onResult: (profile: GoogleProfile | null, error: string | null) => void,
): Promise<void> {
  await ensureInitialised();
  pending = onResult;
  window.google?.accounts?.id?.renderButton(parent, {
    type: "standard",
    theme: window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "filled_black" : "outline",
    size: "large",
    text: "continue_with",
    shape: "pill",
    logo_alignment: "left",
    width: 280,
  });
}

/** Nudges Google's One Tap prompt, for returning visitors. Failure is not an error. */
export async function promptOneTap(
  onResult: (profile: GoogleProfile | null, error: string | null) => void,
): Promise<void> {
  try {
    await ensureInitialised();
    pending = onResult;
    window.google?.accounts?.id?.prompt();
  } catch {
    /* One Tap is a convenience; the button is always there. */
  }
}
