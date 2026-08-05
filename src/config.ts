/**
 * Build-time configuration.
 *
 * There are two operating modes, chosen automatically:
 *
 *   DIRECT   — no Supabase configured. Google sign-in happens entirely in the browser
 *              with Google Identity Services, and the editor is served from this same
 *              GitHub Pages site. Nothing external to set up beyond a Google Client ID.
 *
 *   SUPABASE — VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set. Sign-in goes
 *              through Supabase Auth, a server-enforced shared-password gate applies,
 *              and the editor is delivered from a private bucket only after that gate
 *              is passed.
 *
 * The security difference is real and is stated plainly in the UI and in
 * docs/SECURITY_MODEL.md. Direct mode cannot enforce anything server-side, because in
 * direct mode there is no server.
 *
 * What must NEVER appear in this file, or anywhere in this repository:
 *   - a Google OAuth client SECRET (starts with GOCSPX-)
 *   - the Supabase service-role / secret key
 *   - the shared access password, or anything derived from it
 *
 * A Google Client ID is NOT in that list. It is public by design — it is sent to every
 * browser that loads the sign-in button. What protects it is the authorised-origin
 * restriction on the OAuth client, not secrecy.
 */

export type Mode = "direct" | "supabase";

interface AppConfig {
  mode: Mode;
  supabaseUrl: string;
  supabaseAnonKey: string;
  googleClientId: string;
  basePath: string;
  /** Where Google/Supabase should return the browser after sign-in. */
  redirectTo: string;
  configured: boolean;
  configError: string | null;
}

function readEnv(name: string): string {
  const value = (import.meta.env as Record<string, string | undefined>)[name];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Works out the directory this page is served from, at runtime.
 *
 * Derived rather than baked in, so the same build runs at the project-site path
 * (/LaTeXRenderer/), at a bare user-site root, and at localhost, without a rebuild.
 * Google requires the OAuth origin to match exactly, so getting this wrong is precisely
 * what a hard-coded value invites the moment a repository is renamed.
 */
function detectBasePath(): string {
  if (typeof location === "undefined") return "/";
  const path = location.pathname;
  const trimmed = /\/[^/]*\.[^/]*$/.test(path) ? path.replace(/\/[^/]*$/, "/") : path;
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

/**
 * The default Google Client ID for this deployment.
 *
 * Overridable with VITE_GOOGLE_CLIENT_ID. Public by design; see the header comment.
 */
const DEFAULT_GOOGLE_CLIENT_ID =
  "948316320373-ltmmmo6bgtr6lihrp735i7gkm38mjvn0.apps.googleusercontent.com";

function build(): AppConfig {
  const supabaseUrl = readEnv("VITE_SUPABASE_URL").replace(/\/+$/, "");
  const supabaseAnonKey = readEnv("VITE_SUPABASE_ANON_KEY");
  const googleClientId = readEnv("VITE_GOOGLE_CLIENT_ID") || DEFAULT_GOOGLE_CLIENT_ID;
  const basePath = readEnv("VITE_BASE_PATH") || detectBasePath();

  const mode: Mode = supabaseUrl && supabaseAnonKey ? "supabase" : "direct";
  const problems: string[] = [];

  // A client secret pasted where an ID belongs would be published to every visitor.
  // Refuse to start rather than ship it.
  if (/^GOCSPX-/.test(googleClientId)) {
    problems.push(
      "VITE_GOOGLE_CLIENT_ID is a Google client SECRET, not a Client ID. Refusing to start.",
    );
  } else if (!googleClientId.endsWith(".apps.googleusercontent.com")) {
    problems.push(
      `VITE_GOOGLE_CLIENT_ID does not look like a Client ID: ${googleClientId.slice(0, 24)}…`,
    );
  }

  if (mode === "supabase") {
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i.test(supabaseUrl)) {
      problems.push(`VITE_SUPABASE_URL does not look like a Supabase project URL: ${supabaseUrl}`);
    }
    if (supabaseAnonKey.includes("service_role")) {
      problems.push("VITE_SUPABASE_ANON_KEY contains a service-role key. Refusing to start.");
    }
    if (/^sb_secret_/.test(supabaseAnonKey)) {
      problems.push("VITE_SUPABASE_ANON_KEY is a Supabase secret key. Refusing to start.");
    }
    try {
      if (supabaseAnonKey.startsWith("eyJ")) {
        const payload = JSON.parse(atob(supabaseAnonKey.split(".")[1] ?? ""));
        if (payload?.role === "service_role") {
          problems.push("VITE_SUPABASE_ANON_KEY decodes to role=service_role. Refusing to start.");
        }
      }
    } catch {
      /* An undecodable key is caught by Supabase itself. */
    }
  }

  const origin = typeof location !== "undefined" ? location.origin : "";

  return {
    mode,
    supabaseUrl,
    supabaseAnonKey,
    googleClientId,
    basePath,
    redirectTo: `${origin}${basePath}`,
    configured: problems.length === 0,
    configError: problems.length ? problems.join("\n") : null,
  };
}

export const config = build();

/** Endpoint names, kept in one place so the shell and its tests cannot drift apart. */
export const FUNCTIONS = {
  checkAccess: "check-site-access",
  verifyPassword: "verify-site-password",
  getApp: "get-protected-app",
  revokeAccess: "revoke-site-access",
  deleteAccount: "delete-account",
} as const;

export const LEGAL_NOTICE =
  "Independent LaTeX editor. Not affiliated with or endorsed by Overleaf.";
