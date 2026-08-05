# UnderRock — public shell

**https://julianattemptscoding.github.io/LaTeXRenderer/**

This repository is the small public front door to UnderRock, a free collaborative LaTeX
environment for a team of up to ten people. It contains the landing page, Google sign-in,
the shared-password form, and the loader that fetches and verifies the editor application.

The editor itself is **not** in this repository. Its source and its built bundle live in
[`texCompiler`](https://github.com/JulianAttemptsCoding/texCompiler), and the bundle is
served from a private Supabase Storage bucket only to a signed-in user who has passed the
password gate.

> Independent LaTeX editor. Not affiliated with or endorsed by Overleaf.

---

## What this repository can and cannot protect

GitHub Pages is static file hosting. It cannot authenticate anyone, it cannot keep a
secret, and nothing shipped from here is hidden. This repository does not pretend
otherwise. Concretely:

**It cannot** hide the shared password (it is never here), hide the editor bundle (it is
never here), or decide who is allowed in.

**It can** collect a Google identity, forward a password attempt to a server that knows how
to check it, and refuse to execute any application bytes that do not match the fingerprints
the server published for them.

Every authorization decision happens in a Supabase Edge Function against a row in the
`site_access_grants` table. Deleting the password form in DevTools, setting
`localStorage.hasAccess = true`, calling shell functions from the console, or requesting the
private bucket directly all fail — not because the shell resists them, but because the shell
was never the thing standing in the way. `tests/e2e/security.spec.ts` asserts each of those
attacks individually.

Full reasoning: [`docs/SECURITY_MODEL.md`](docs/SECURITY_MODEL.md).

---

## How a visit works

```
  browser                     Supabase                  private bucket
     |                            |                            |
     |-- Continue with Google --->|  (PKCE, openid email profile)
     |<------- session -----------|
     |                            |
     |-- check-site-access ------>|  reads site_access_grants
     |<-- { hasAccess: false } ---|
     |                            |
     |-- verify-site-password --->|  PBKDF2 x310000, constant-time,
     |                            |  5 failures / 15 min, never logged
     |<-- { ok, expiresAt } ------|  writes the grant
     |                            |
     |-- get-protected-app ------>|  re-checks the grant, then signs
     |<-- manifest + 5-min URLs --|  ------------------------------->|
     |                                                              |
     |<--------------- asset bytes ---------------------------------|
     |
     |  SHA-256 every asset against the manifest.
     |  Any mismatch: refuse to execute, show "Refused to start".
     |  All match: inject styles, mint blob: URLs, run the bundle.
```

---

## Running it locally

```bash
npm install
```

Point it at a Supabase project. Both values are public; there is no secret to protect here.

```bash
cp .env.example .env.local
# then edit .env.local
```

```bash
npm run dev
```

Open http://localhost:5173. Sign-in will only work once the Supabase project has Google
auth configured and your own Google account is on its test-user list — see
[`SETUP_EVERYTHING_NONTECHNICAL.md`](https://github.com/JulianAttemptsCoding/texCompiler/blob/main/SETUP_EVERYTHING_NONTECHNICAL.md).

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Development server on :5173 |
| `npm run build` | Production build into `dist/`, plus `404.html` and `.nojekyll` |
| `npm run preview` | Serve the built output on :4173 |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint, including the rules banning `innerHTML` and `eval` in the shell |
| `npm run test` | Vitest unit tests (integrity verification, cache, teardown) |
| `npm run test:e2e` | Playwright security and workflow suite |
| `npm run scan:secrets` | Fail if credential material or the literal password appears anywhere |
| `npm run verify` | All of the above, in the order CI runs them |

---

## Deployment

`.github/workflows/pages.yml` runs on every push to `main`:

1. typecheck → lint → unit tests → Playwright
2. build with the base path `/LaTeXRenderer/`
3. scan `dist/` for credential material and fail the run on any hit
4. publish to GitHub Pages
5. smoke-test the live URL, including that a hashed asset and `404.html` both return 200

Two **repository variables** must be set (Settings → Secrets and variables → Actions →
Variables). They are variables rather than secrets because both are public:

| Name | Example |
|---|---|
| `VITE_SUPABASE_URL` | `https://abcdefghijklm.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | the project's publishable/anon key |

One optional **secret**, used only to prove a negative:

| Name | Purpose |
|---|---|
| `SHARED_PASSWORD_CANARY` | The literal shared password, so CI can assert it appears nowhere in the built output. If unset, that check reports **SKIPPED** rather than passing. |

The build refuses to start if `VITE_SUPABASE_ANON_KEY` decodes to `role: service_role`.

---

## Layout

```
index.html                 shell markup; no application logic
src/
  main.ts                  the state machine: signed out -> gated -> running
  config.ts                build-time public config, with anti-footgun validation
  styles.css               the whole stylesheet (~4.6 kB)
  lib/
    supabase.ts            PKCE client and Edge Function calls
    protectedApp.ts        fetch, SHA-256 verify, blob-execute, tear down
    dom.ts                 element helper; textContent only, never innerHTML
  views/index.ts           landing, password, progress, error, locked
tests/
  unit/                    Vitest
  e2e/                     Playwright, incl. the security suite
.github/workflows/pages.yml
```

## Licence

MIT. See [LICENSE](LICENSE).
