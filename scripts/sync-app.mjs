#!/usr/bin/env node
/**
 * Copies the built editor from the sibling texCompiler repository into public/app/, so
 * direct mode can serve it from this same GitHub Pages site.
 *
 *   node scripts/sync-app.mjs                    # looks for ../texCompiler/app/dist
 *   node scripts/sync-app.mjs <path-to-dist>
 *
 * Only the assets the manifest actually serves are copied, and each is re-hashed
 * here rather than trusted from the manifest. That turns a truncated or partially-written
 * copy into a build failure instead of a page that refuses to start at runtime, which is a
 * far worse place to discover it.
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const TARGET = join(ROOT, "public", "app");

const source = resolve(
  process.argv[2] ?? join(ROOT, "..", "texCompiler", "app", "dist"),
);

if (!existsSync(join(source, "manifest.json"))) {
  console.error(
    `No build found at ${source}\n\n` +
      `Build it first:\n` +
      `  cd ../texCompiler && node scripts/build-protected-app.mjs\n\n` +
      `Or pass the path explicitly:\n` +
      `  node scripts/sync-app.mjs /path/to/texCompiler/app/dist`,
  );
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));

rmSync(TARGET, { recursive: true, force: true });
mkdirSync(TARGET, { recursive: true });

let total = 0;
for (const asset of manifest.assets) {
  if (asset.path.includes("..") || asset.path.startsWith("/")) {
    console.error(`Refusing unsafe manifest path: ${asset.path}`);
    process.exit(1);
  }

  const from = join(source, asset.path);
  const to = join(TARGET, asset.path);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);

  // Re-hash the COPY, not the original.
  const bytes = readFileSync(to);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== asset.sha256) {
    console.error(
      `Copy of ${asset.path} does not match its manifest digest.\n` +
        `  expected ${asset.sha256}\n  got      ${digest}`,
    );
    process.exit(1);
  }
  if (bytes.byteLength !== asset.size) {
    console.error(`Copy of ${asset.path} is ${bytes.byteLength} bytes, expected ${asset.size}.`);
    process.exit(1);
  }

  total += bytes.byteLength;
  console.log(`  ${(bytes.byteLength / 1024).toFixed(1).padStart(9)} KiB  ${asset.path}`);
}

writeFileSync(join(TARGET, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

console.log(
  `\nsynced build ${manifest.buildId} — ${(total / 1024 / 1024).toFixed(2)} MiB across ` +
    `${manifest.assets.length} assets into public/app/`,
);
console.log("Every byte was re-hashed after copying and matches the manifest.");
