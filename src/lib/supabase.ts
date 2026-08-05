import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "../config";

let client: SupabaseClient | null = null;

/**
 * Supabase browser client.
 *
 * flowType "pkce" is required, not optional: an implicit-flow token would land in the URL
 * fragment where it can leak through history, the Referer header, and any extension with
 * page access. PKCE exchanges a short-lived code instead.
 */
export function supabase(): SupabaseClient {
  if (client) return client;
  client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: {
      flowType: "pkce",
      detectSessionInUrl: true,
      persistSession: true,
      autoRefreshToken: true,
      storageKey: "underrock.auth",
    },
    global: {
      headers: { "x-underrock-shell": "1" },
    },
  });
  return client;
}

export async function currentSession(): Promise<Session | null> {
  const { data, error } = await supabase().auth.getSession();
  if (error) return null;
  return data.session;
}

export async function signInWithGoogle(): Promise<{ error: string | null }> {
  const { error } = await supabase().auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: config.redirectTo,
      // Exactly the OpenID Connect basics. Drive access is requested separately, later,
      // and only if the user asks for it -- so signing in never implies file access.
      scopes: "openid email profile",
      queryParams: { prompt: "select_account" },
    },
  });
  return { error: error?.message ?? null };
}

export async function signOut(): Promise<void> {
  await supabase().auth.signOut();
}

/**
 * Calls an Edge Function with the caller's bearer token.
 *
 * Returns the parsed body plus the HTTP status; callers must branch on status because a
 * denial is a normal, expected outcome rather than an exception.
 */
export async function callFunction<T>(
  name: string,
  body: Record<string, unknown> = {},
): Promise<{ status: number; data: T | null; error: string | null }> {
  const session = await currentSession();
  if (!session) return { status: 401, data: null, error: "Not signed in." };

  let response: Response;
  try {
    response = await fetch(`${config.supabaseUrl}/functions/v1/${name}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
        apikey: config.supabaseAnonKey,
      },
      body: JSON.stringify(body),
    });
  } catch {
    return { status: 0, data: null, error: "Could not reach the server. Check your connection." };
  }

  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    /* Some error paths legitimately return an empty body. */
  }

  const message =
    parsed && typeof parsed === "object" && "error" in parsed
      ? String((parsed as { error: unknown }).error)
      : null;

  return {
    status: response.status,
    data: response.ok ? (parsed as T) : null,
    error: response.ok ? null : (message ?? `Request failed (${response.status})`),
  };
}
