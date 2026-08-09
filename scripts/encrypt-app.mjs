#!/usr/bin/env node
/**
 * Encrypts the editor bundle so the shared password is genuinely required to run it.
 *
 * WHY THIS EXISTS
 * ---------------
 * In direct mode there is no server, so a password *checked* in JavaScript protects
 * nothing: an attacker reads the check out of the bundle and deletes it. Encrypting the
 * bundle removes the thing to bypass — without the password there is no plaintext to run.
 *
 *   key        = PBKDF2-HMAC-SHA256(password, salt, 310_000) -> 256 bits
 *   ciphertext = AES-256-GCM(key, iv, plaintext)
 *
 * AES-GCM is authenticated, so a wrong password fails the tag check rather than producing
 * garbage that might half-execute. Each asset gets its own random IV; the salt is shared
 * and public.
 *
 * WHAT THIS DOES NOT DO
 * ---------------------
 * The ciphertext is public, so an attacker can brute-force offline. Strength is
 * (password entropy x KDF cost), nothing more. This is much stronger than a JavaScript
 * check and weaker than the server-side gate in Supabase mode, where five wrong guesses
 * per fifteen minutes is enforced by something the attacker does not control.
 *
 * USAGE — the password is never written to disk, never printed, never in argv:
 *
 *   node scripts/encrypt-app.mjs                    # hidden prompt
 *   SHARED_PASSWORD=... node scripts/encrypt-app.mjs --from-env
 *
 * Reads public/app/ (plaintext, produced by sync-app.mjs) and writes public/app-locked/.
 * It then DELETES public/app/, because leaving the plaintext beside the ciphertext would
 * make the whole exercise pointless.
 */

import { createCipheriv, createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const ITERATIONS = 310_000; // OWASP PBKDF2-HMAC-SHA256 floor
const SALT_BYTES = 32;
const KEY_BYTES = 32;
const IV_BYTES = 12; // GCM standard

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const PLAIN = join(ROOT, "public", "app");
const LOCKED = join(ROOT, "public", "app-locked");

function promptHidden(question) {
  return new Promise((resolvePrompt) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) {
      let buf = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (c) => (buf += c));
      stdin.on("end", () => resolvePrompt(buf.replace(/\r?\n$/, "")));
      return;
    }
    stdout.write(question);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const ENTER = ["\r", "\n", ""];
    const onData = (ch) => {
      if (ENTER.includes(ch)) {
        stdin.setRawMode(wasRaw);
        stdin.pause();
        stdin.removeListener("data", onData);
        stdout.write("\n");
        resolvePrompt(value);
      } else if (ch === "") {
        stdin.setRawMode(wasRaw);
        stdout.write("\n");
        process.exit(130);
      } else if (ch === "" || ch === "") {
        value = value.slice(0, -1);
      } else if (ch >= " ") {
        value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

const main = async () => {
  if (!existsSync(join(PLAIN, "manifest.json"))) {
    console.error(
      `No plaintext bundle at ${PLAIN}\n\n` +
        `Run this first:\n` +
        `  cd ../texCompiler && node scripts/build-protected-app.mjs\n` +
        `  cd ../LaTeXRenderer && npm run sync:app`,
    );
    process.exit(1);
  }

  let password;
  if (process.argv.includes("--from-env")) {
    password = process.env.SHARED_PASSWORD ?? "";
    if (!password) {
      console.error("--from-env given but SHARED_PASSWORD is empty.");
      process.exit(1);
    }
  } else {
    console.log("Encrypting the editor bundle with the shared access password.");
    console.log("Nothing you type is displayed, saved, or logged.\n");
    password = await promptHidden("Shared access password: ");
    if (!password) {
      console.error("Empty password. Nothing was changed.");
      process.exit(1);
    }
    if (process.stdin.isTTY) {
      const again = await promptHidden("Type it once more to confirm: ");
      if (again !== password) {
        console.error("The two entries did not match. Nothing was changed.");
        process.exit(1);
      }
    }
  }

  const manifest = JSON.parse(readFileSync(join(PLAIN, "manifest.json"), "utf8"));
  const salt = randomBytes(SALT_BYTES);

  const started = Date.now();
  const key = pbkdf2Sync(Buffer.from(password, "utf8"), salt, ITERATIONS, KEY_BYTES, "sha256");
  const kdfMs = Date.now() - started;
  password = ""; // drop the reference promptly

  rmSync(LOCKED, { recursive: true, force: true });
  mkdirSync(LOCKED, { recursive: true });

  const assets = [];
  for (const asset of manifest.assets) {
    if (asset.path.includes("..") || asset.path.startsWith("/")) {
      console.error(`Refusing unsafe manifest path: ${asset.path}`);
      process.exit(1);
    }
    const plaintext = readFileSync(join(PLAIN, asset.path));

    // Sanity: the plaintext must still match what the build recorded.
    const digest = createHash("sha256").update(plaintext).digest("hex");
    if (digest !== asset.sha256) {
      console.error(`${asset.path} does not match its manifest digest; refusing to encrypt.`);
      process.exit(1);
    }

    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    // iv || ciphertext || tag, so the browser can slice it without a second request.
    const packed = Buffer.concat([iv, body, tag]);
    const outName = `${asset.path.replace(/[^A-Za-z0-9._-]/g, "_")}.enc`;
    writeFileSync(join(LOCKED, outName), packed);

    assets.push({
      path: asset.path,
      file: outName,
      // Digest of the PLAINTEXT. Checked after decryption, so a correct password that
      // yields unexpected bytes is still refused.
      sha256: asset.sha256,
      size: asset.size,
      contentType: asset.contentType,
      encryptedSize: packed.byteLength,
    });
    console.log(`  ${(packed.byteLength / 1024).toFixed(1).padStart(9)} KiB  ${outName}`);
  }

  const envelope = {
    schemaVersion: 1,
    encrypted: true,
    algorithm: "AES-256-GCM",
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: ITERATIONS, saltB64: salt.toString("base64") },
    ivBytes: IV_BYTES,
    tagBytes: 16,
    buildId: manifest.buildId,
    entry: manifest.entry,
    styles: manifest.styles ?? [],
    worker: manifest.worker ?? null,
    compilerWorker: manifest.compilerWorker ?? null,
    xzWasm: manifest.xzWasm ?? null,
    assets,
  };
  writeFileSync(join(LOCKED, "envelope.json"), JSON.stringify(envelope, null, 2) + "\n");

  // Leaving the plaintext next to the ciphertext would defeat the entire point.
  rmSync(PLAIN, { recursive: true, force: true });

  const total = assets.reduce((n, a) => n + a.encryptedSize, 0);
  console.log(`\nlocked build ${manifest.buildId}`);
  console.log(`  PBKDF2-HMAC-SHA256 x ${ITERATIONS} derived in ${kdfMs} ms`);
  console.log(`  ${(total / 1024 / 1024).toFixed(2)} MiB of ciphertext in public/app-locked/`);
  console.log(`  plaintext public/app/ removed`);

  // Belt and braces: prove no plaintext JavaScript survived anywhere under public/.
  const stray = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|css)$/.test(e.name)) stray.push(p);
    }
  };
  walk(join(ROOT, "public"));
  if (stray.length) {
    console.error(`\nPlaintext bundle files still present:\n  ${stray.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`  verified: no plaintext .js or .css remains under public/`);
};

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
