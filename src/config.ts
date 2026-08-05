/**
 * Build-time configuration.
 *
 * Both values below are PUBLIC by design and are injected from GitHub Actions
 * *variables*, not secrets. The Supabase publishable (anon) key is meant to ship in a
 * browser: it identifies the project and nothing more. It is safe here only because every
 * table, function, and storage bucket in the project is behind RLS or an authenticated
 * Edge Function -- see docs/SECURITY_MODEL.md.
 *
 * What must NEVER appear in this file, or anywhere else in this repository:
 *   - the Supabase service-role / secret key
 *   - the Google OAuth client secret
 *   - the shared access password, or any value derived from it
 */

interface AppConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  basePath: string;
  /** Where Supabase should send the browser back after Google sign-in. */
  redirectTo: string;
  configured: boolean;
  configError: string | null;
}

function readEnv(name: string): string {
  const value = (import.meta.env as Record<string, string | undefined>)[name];
  return typeof value === "string" ? value.trim() : "";
}

function build(): AppConfig {
  const supabaseUrl = readEnv("VITE_SUPABASE_URL").replace(/\/+$/, "");
  const supabaseAnonKey = readEnv("VITE_SUPABASE_ANON_KEY");
  const basePath = readEnv("VITE_BASE_PATH") || "/LaTeXRenderer/";

  const problems: string[] = [];
  if (!supabaseUrl) problems.push("VITE_SUPABASE_URL is not set");
  else if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i.test(supabaseUrl)) {
    problems.push(`VITE_SUPABASE_URL does not look like a Supabase project URL: ${supabaseUrl}`);
  }
  if (!supabaseAnonKey) problems.push("VITE_SUPABASE_ANON_KEY is not set");

  // A service-role key pasted into the anon slot would be a catastrophic misconfiguration,
  // so it is refused at startup rather than quietly shipped to every visitor.
  if (supabaseAnonKey.includes("service_role")) {
    problems.push("VITE_SUPABASE_ANON_KEY contains a service-role key. Refusing to start.");
  }
  if (/^sb_secret_/.test(supabaseAnonKey)) {
    problems.push("VITE_SUPABASE_ANON_KEY is a Supabase secret key. Refusing to start.");
  }
  try {
    if (supabaseAnonKey.startsWith("eyJ")) {
      const parts = supabaseAnonKey.split(".");
      const payload = JSON.parse(atob(parts[1] ?? ""));
      if (payload?.role === "service_role") {
        problems.push("VITE_SUPABASE_ANON_KEY decodes to role=service_role. Refusing to start.");
      }
    }
  } catch {
    /* An undecodable key is caught by Supabase itself; not a reason to halt here. */
  }

  const origin = typeof location !== "undefined" ? location.origin : "";
  const redirectTo = `${origin}${basePath}`;

  return {
    supabaseUrl,
    supabaseAnonKey,
    basePath,
    redirectTo,
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
