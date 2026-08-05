#!/usr/bin/env node
/**
 * Forbidden-material scanner. Runs in CI for both repositories and locally via
 * `npm run scan:secrets`.
 *
 * The shared password itself is NEVER embedded in this file. CI supplies it through the
 * SHARED_PASSWORD_CANARY secret; when the variable is absent the literal check is reported
 * as SKIPPED rather than silently passing, so a missing secret cannot be mistaken for a
 * clean scan.
 *
 * Exit code 0 = clean, 1 = at least one finding.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import process from "node:process";

const roots = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (roots.length === 0) roots.push(".");

const SKIP_DIRS = new Set([
  ".git", "node_modules", ".secrets", "dist", "coverage", ".vite",
  "playwright-report", "test-results", "__pycache__", ".venv", "venv", "build",
]);
// dist/ is skipped by default because CI scans it explicitly with --include-dist.
if (process.argv.includes("--include-dist")) {
  SKIP_DIRS.delete("dist");
  SKIP_DIRS.delete("build");
}

const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".eot",
  ".pdf", ".zip", ".gz", ".wasm", ".exe", ".dll", ".so", ".dylib", ".pyc",
]);

/** @type {{name: string, re: RegExp, why: string}[]} */
const PATTERNS = [
  {
    name: "supabase-service-role-jwt",
    re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]*?(?:service_role|"role"\s*:\s*"service_role")[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+/,
    why: "A service-role JWT grants full RLS bypass and must never leave the server.",
  },
  {
    name: "supabase-secret-key",
    re: /\bsb_secret_[A-Za-z0-9_-]{10,}/,
    why: "Supabase secret keys bypass RLS.",
  },
  {
    name: "service-role-env-assignment",
    re: /SUPABASE_SERVICE_ROLE_KEY\s*[=:]\s*["'`][^"'`\n]{20,}/,
    why: "Hard-coded service-role key.",
  },
  {
    name: "google-client-secret",
    re: /\bGOCSPX-[A-Za-z0-9_-]{10,}/,
    why: "Google OAuth client secrets belong in Supabase Auth settings only.",
  },
  {
    name: "google-client-secret-assignment",
    re: /(?:client_secret|GOOGLE_CLIENT_SECRET)\s*[=:]\s*["'`][^"'`\n]{10,}/i,
    why: "Google OAuth client secret must not appear in any repository file.",
  },
  {
    name: "private-key-block",
    re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
    why: "Private key material.",
  },
  {
    name: "supabase-access-token",
    re: /\bsbp_[0-9a-f]{40,}/,
    why: "Supabase personal access token.",
  },
  {
    name: "github-token",
    re: /\bgh[pousr]_[A-Za-z0-9]{30,}/,
    why: "GitHub token.",
  },
  {
    name: "derived-password-material",
    re: /SITE_PASSWORD_(?:HASH_B64|SALT_B64)\s*[=:]\s*["'`]?[A-Za-z0-9+/]{20,}={0,2}/,
    why: "PBKDF2 material belongs in Edge Function secrets, not in the repository.",
  },
];

const canary = process.env.SHARED_PASSWORD_CANARY ?? "";
let canaryChecked = false;
if (canary.length >= 8) {
  canaryChecked = true;
  PATTERNS.push({
    name: "literal-shared-password",
    // Escape every regex metacharacter; the password contains ':' and may contain others.
    re: new RegExp(canary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    why: "The literal shared access password must never appear in any artifact.",
  });
}

/** @type {{file: string, line: number, pattern: string, why: string}[]} */
const findings = [];
let filesScanned = 0;

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") && SKIP_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full);
    } else if (e.isFile()) {
      scan(full);
    }
  }
}

function scan(file) {
  const lower = file.toLowerCase();
  if ([...BINARY_EXT].some((ext) => lower.endsWith(ext))) return;
  let size;
  try {
    size = statSync(file).size;
  } catch {
    return;
  }
  if (size > 12 * 1024 * 1024) return;

  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  filesScanned++;

  // This scanner necessarily contains the pattern strings themselves.
  if (file.endsWith("scan-secrets.mjs")) return;

  for (const p of PATTERNS) {
    if (!p.re.test(text)) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (p.re.test(lines[i])) {
        findings.push({ file, line: i + 1, pattern: p.name, why: p.why });
        break;
      }
    }
  }
}

for (const r of roots) walk(resolve(r));

console.log(`secret scan: ${filesScanned} text files under ${roots.join(", ")}`);
console.log(
  canaryChecked
    ? "literal shared-password check: ENABLED (SHARED_PASSWORD_CANARY provided)"
    : "literal shared-password check: SKIPPED -- SHARED_PASSWORD_CANARY was not set",
);

if (findings.length === 0) {
  console.log("no forbidden material found");
  process.exit(0);
}

console.error(`\n${findings.length} finding(s):`);
for (const f of findings) {
  const rel = relative(process.cwd(), f.file).split(sep).join("/");
  console.error(`  ${rel}:${f.line}  [${f.pattern}] ${f.why}`);
}
process.exit(1);
