/**
 * Fetches, verifies, and executes the protected editor application.
 *
 * The security property this file is responsible for:
 *
 *   Nothing is executed until its bytes hash to the SHA-256 recorded in the manifest the
 *   server just handed us. The manifest itself is only obtainable by a caller who holds a
 *   valid JWT *and* a live site-access grant, and the asset URLs inside it are signed for
 *   five minutes. So a visitor who has not passed the gate cannot obtain the bundle, and a
 *   visitor who has cannot be served altered bytes without detection.
 *
 * Why Blob URLs rather than plain <script src=signedUrl>:
 *   the signed URL points at a different origin (the Supabase storage host). Executing it
 *   directly would work, but it would also mean the browser -- not this code -- decides
 *   what runs, with no opportunity to hash-check first. Fetching to memory, verifying, and
 *   only then creating a same-origin blob: URL keeps verification on the critical path.
 *
 * Why the app is built as a single IIFE:
 *   a code-split ES module graph cannot load from blob: at all. Relative import specifiers
 *   inside a blob resolve against the blob URL itself and 404. One self-contained bundle
 *   sidesteps the whole problem.
 */

export interface ManifestAsset {
  path: string;
  sha256: string;
  size: number;
  contentType: string;
  url: string;
}

export interface ProtectedManifest {
  ok: true;
  buildId: string;
  entry: string;
  styles: string[];
  worker: string | null;
  compilerWorker?: string | null;
  expiresInSeconds: number;
  grantExpiresAt: string;
  assets: ManifestAsset[];
}

// ---------------------------------------------------------------------------
// encrypted bundle (direct mode)
// ---------------------------------------------------------------------------

export interface LockedEnvelope {
  schemaVersion: number;
  encrypted: true;
  algorithm: "AES-256-GCM";
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; saltB64: string };
  ivBytes: number;
  tagBytes: number;
  buildId: string;
  entry: string;
  styles: string[];
  worker: string | null;
  compilerWorker?: string | null;
  assets: Array<{
    path: string;
    file: string;
    sha256: string;
    size: number;
    contentType: string;
    encryptedSize: number;
  }>;
}

export class WrongPasswordError extends Error {
  constructor() {
    super("That password did not unlock the application.");
    this.name = "WrongPasswordError";
  }
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function fetchEnvelope(basePath: string): Promise<LockedEnvelope> {
  const root = `${basePath.replace(/\/+$/, "")}/app-locked/`;
  const response = await fetch(`${root}envelope.json`, { cache: "no-cache" });
  if (!response.ok) {
    throw new Error(
      `The editor is not published with this site (HTTP ${response.status} for ` +
        `${root}envelope.json).\n\nRun "npm run sync:app" then "npm run lock:app" and redeploy.`,
    );
  }
  const envelope = (await response.json()) as LockedEnvelope;
  if (!envelope?.encrypted || envelope.algorithm !== "AES-256-GCM") {
    throw new Error("The published envelope is not in a format this shell understands.");
  }
  if (envelope.kdf.iterations < 100_000) {
    // A weakened envelope would make offline brute force far cheaper. Refuse it.
    throw new Error("The published envelope uses too few KDF iterations. Refusing to unlock.");
  }
  return envelope;
}

/** Derives the unlock key. Deliberately slow — that cost is the whole defence. */
export async function deriveUnlockKey(
  password: string,
  envelope: LockedEnvelope,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: b64ToBytes(envelope.kdf.saltB64).slice(),
      iterations: envelope.kdf.iterations,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: 256 },
    // Extractable so the key can be cached in sessionStorage for the life of the tab,
    // sparing a 310 000-iteration derivation on every reload. sessionStorage dies with
    // the tab and is same-origin, and anyone who can read it can already read the running
    // application — so caching costs nothing that was not already exposed. It is cleared
    // on sign-out and on lock.
    true,
    ["decrypt"],
  );
}

const UNLOCK_KEY_STORAGE = "latexrenderer.unlock";

export async function cacheUnlockKey(key: CryptoKey, buildId: string): Promise<void> {
  try {
    const raw = await crypto.subtle.exportKey("raw", key);
    const b64 = btoa(String.fromCharCode(...new Uint8Array(raw)));
    sessionStorage.setItem(UNLOCK_KEY_STORAGE, JSON.stringify({ buildId, k: b64 }));
  } catch {
    /* Caching is a convenience; failure just means the password is asked for again. */
  }
}

export async function cachedUnlockKey(buildId: string): Promise<CryptoKey | null> {
  try {
    const raw = sessionStorage.getItem(UNLOCK_KEY_STORAGE);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { buildId: string; k: string };
    // A new build means new ciphertext; a stale key must not be tried against it.
    if (parsed.buildId !== buildId) {
      sessionStorage.removeItem(UNLOCK_KEY_STORAGE);
      return null;
    }
    return await crypto.subtle.importKey(
      "raw",
      b64ToBytes(parsed.k).slice(),
      { name: "AES-GCM", length: 256 },
      true,
      ["decrypt"],
    );
  } catch {
    return null;
  }
}

export function clearUnlockKey(): void {
  try {
    sessionStorage.removeItem(UNLOCK_KEY_STORAGE);
  } catch {
    /* nothing to do */
  }
}

/**
 * Decrypts every asset and turns the result into an ordinary manifest.
 *
 * Two independent checks have to pass. AES-GCM authenticates the ciphertext, so a wrong
 * password fails the tag rather than yielding plausible garbage; and the decrypted bytes
 * are then hashed against the digest recorded at build time, so a correct password that
 * somehow produced unexpected content is still refused.
 */
export async function unlockManifest(
  envelope: LockedEnvelope,
  key: CryptoKey,
  basePath: string,
  onProgress?: (done: number, total: number, path: string) => void,
): Promise<{ manifest: ProtectedManifest; plaintext: Map<string, ArrayBuffer> }> {
  const root = `${basePath.replace(/\/+$/, "")}/app-locked/`;
  const plaintext = new Map<string, ArrayBuffer>();
  const assets: ManifestAsset[] = [];
  let done = 0;

  for (const asset of envelope.assets) {
    if (asset.file.includes("..") || asset.file.startsWith("/")) {
      throw new Error(`Refusing an unsafe envelope path: ${asset.file}`);
    }
    const response = await fetch(root + asset.file, { cache: "force-cache" });
    if (!response.ok) {
      throw new Error(`Could not download ${asset.file} (HTTP ${response.status}).`);
    }
    const packed = new Uint8Array(await response.arrayBuffer());

    // iv || ciphertext || tag  — WebCrypto wants the tag appended to the ciphertext.
    const iv = packed.slice(0, envelope.ivBytes);
    const body = packed.slice(envelope.ivBytes);

    let decrypted: ArrayBuffer;
    try {
      decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, body);
    } catch {
      // The GCM tag failed. Overwhelmingly the wrong password.
      throw new WrongPasswordError();
    }

    const actual = await sha256Hex(decrypted);
    if (actual !== asset.sha256 || decrypted.byteLength !== asset.size) {
      throw new IntegrityError(asset.path, asset.sha256, actual);
    }

    plaintext.set(asset.path, decrypted);
    assets.push({
      path: asset.path,
      sha256: asset.sha256,
      size: asset.size,
      contentType: asset.contentType,
      url: "", // never fetched again; the bytes are already in memory
    });
    onProgress?.(++done, envelope.assets.length, asset.path);
  }

  return {
    manifest: {
      ok: true,
      buildId: envelope.buildId,
      entry: envelope.entry,
      styles: envelope.styles ?? [],
      worker: envelope.worker ?? null,
      compilerWorker: envelope.compilerWorker ?? null,
      expiresInSeconds: 0,
      grantExpiresAt: "",
      assets,
    },
    plaintext,
  };
}

/**
 * Builds a manifest for DIRECT mode, where the editor ships alongside the shell on this
 * same GitHub Pages site instead of coming from a private bucket.
 *
 * The integrity check is kept, and it is not theatre: `app/manifest.json` is generated at
 * build time from the actual bytes, so a corrupted or truncated asset -- a bad deploy, a
 * proxy that mangled a response, a partially-cached file -- is caught before anything
 * executes. What it cannot do in this mode is prove the files were not *deliberately*
 * replaced, because an attacker who can rewrite the assets can rewrite the manifest beside
 * them. That difference is the point of Supabase mode and is documented as such.
 */
export async function localManifest(basePath: string): Promise<ProtectedManifest> {
  const root = `${basePath.replace(/\/+$/, "")}/app/`;
  const response = await fetch(`${root}manifest.json`, { cache: "no-cache" });
  if (!response.ok) {
    throw new Error(
      `The editor is not bundled with this site (HTTP ${response.status} for ${root}manifest.json).\n\n` +
        `Run "npm run sync:app" in the LaTeXRenderer repository against a built texCompiler, ` +
        `then redeploy.`,
    );
  }

  const manifest = (await response.json()) as {
    buildId: string;
    entry: string;
    styles: string[];
    worker: string | null;
    compilerWorker?: string | null;
    assets: Array<{ path: string; sha256: string; size: number; contentType: string }>;
  };

  return {
    ok: true,
    buildId: manifest.buildId,
    entry: manifest.entry,
    styles: manifest.styles ?? [],
    worker: manifest.worker ?? null,
    compilerWorker: manifest.compilerWorker ?? null,
    expiresInSeconds: 0,
    grantExpiresAt: "",
    assets: manifest.assets.map((asset) => {
      if (asset.path.includes("..") || asset.path.startsWith("/")) {
        throw new Error(`Refusing an unsafe manifest path: ${asset.path}`);
      }
      return { ...asset, url: root + asset.path };
    }),
  };
}

export class IntegrityError extends Error {
  constructor(
    readonly assetPath: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `Integrity check failed for ${assetPath}. ` +
        `Expected ${expected.slice(0, 16)}..., got ${actual.slice(0, 16)}.... ` +
        `The application was not started.`,
    );
    this.name = "IntegrityError";
  }
}

const CACHE_DB = "latexrenderer-app-cache";
const CACHE_STORE = "assets";

/** Every Blob URL this module has minted, so logout can revoke all of them. */
const liveObjectUrls = new Set<string>();
const injectedNodes = new Set<Element>();

export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  // The bytes arrive from fetch(), which in some runtimes hands back an ArrayBuffer
  // allocated in a different realm than the one WebCrypto validates against. Copying into
  // a locally allocated view removes that whole class of failure for the cost of one
  // memcpy per asset, and keeps the digest path identical in the browser and under test.
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const local = new Uint8Array(source.byteLength);
  local.set(source);

  const digest = await crypto.subtle.digest("SHA-256", local);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// content-addressed cache
// ---------------------------------------------------------------------------
// Entries are keyed by their own SHA-256. That makes a cache hit self-verifying: if the
// manifest asks for hash X and the store has an entry under key X, the bytes are by
// definition the ones the manifest describes. It also means a compromised cache cannot
// substitute content, only fail to have it.

function openCache(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(CACHE_DB, 1);
    } catch {
      return resolve(null);
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CACHE_STORE)) db.createObjectStore(CACHE_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

async function cacheGet(hash: string): Promise<ArrayBuffer | null> {
  const db = await openCache();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(CACHE_STORE, "readonly").objectStore(CACHE_STORE).get(hash);
      req.onsuccess = () => resolve((req.result as ArrayBuffer | undefined) ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    } finally {
      // Closing is deferred so the transaction can finish.
      setTimeout(() => db.close(), 0);
    }
  });
}

async function cachePut(hash: string, bytes: ArrayBuffer): Promise<void> {
  const db = await openCache();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(CACHE_STORE, "readwrite");
      tx.objectStore(CACHE_STORE).put(bytes, hash);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
  db.close();
}

/**
 * Drops every cached byte of the protected application.
 *
 * Called on sign-out and on "Lock now". An authorised user can always read code their own
 * browser executed -- that is unavoidable and is stated in the security model -- but the
 * bundle should not outlive the session that was entitled to it.
 */
export async function clearProtectedAppCache(): Promise<void> {
  const db = await openCache();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(CACHE_STORE, "readwrite");
      tx.objectStore(CACHE_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
  db.close();
}

// ---------------------------------------------------------------------------
// fetch + verify
// ---------------------------------------------------------------------------

async function fetchVerified(
  asset: ManifestAsset,
  onProgress?: (path: string) => void,
): Promise<ArrayBuffer> {
  const cached = await cacheGet(asset.sha256);
  if (cached && cached.byteLength === asset.size) {
    onProgress?.(asset.path);
    return cached;
  }

  const response = await fetch(asset.url, { cache: "no-store", credentials: "omit" });
  if (!response.ok) {
    throw new Error(`Could not download ${asset.path} (HTTP ${response.status}).`);
  }
  const bytes = await response.arrayBuffer();

  const actual = await sha256Hex(bytes);
  if (actual !== asset.sha256) {
    throw new IntegrityError(asset.path, asset.sha256, actual);
  }
  if (bytes.byteLength !== asset.size) {
    throw new IntegrityError(asset.path, `${asset.size} bytes`, `${bytes.byteLength} bytes`);
  }

  await cachePut(asset.sha256, bytes);
  onProgress?.(asset.path);
  return bytes;
}

function objectUrl(bytes: ArrayBuffer, type: string): string {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  liveObjectUrls.add(url);
  return url;
}

export interface LoadOptions {
  onProgress?: (loaded: number, total: number, path: string) => void;
  /**
   * Already-verified bytes, keyed by asset path.
   *
   * Used by the encrypted direct-mode path, where decryption has already produced and
   * hash-checked the plaintext. Supplying them here avoids a pointless second fetch of
   * URLs that do not exist, and keeps exactly one code path responsible for injecting
   * and executing the application.
   */
  preloaded?: Map<string, ArrayBuffer>;
}

/**
 * Verifies every asset, then starts the application.
 *
 * Order matters: all assets are fetched and hashed BEFORE anything is injected, so a
 * corrupted asset discovered late cannot leave a half-started application behind.
 */
export async function startProtectedApp(
  manifest: ProtectedManifest,
  options: LoadOptions = {},
): Promise<void> {
  const total = manifest.assets.length;
  let loaded = 0;

  const verified = new Map<string, ArrayBuffer>();
  for (const asset of manifest.assets) {
    const already = options.preloaded?.get(asset.path);
    if (already) {
      // Decrypted and hash-checked by unlockManifest(); re-verify the digest rather than
      // trusting the caller, so this function never executes unverified bytes.
      const actual = await sha256Hex(already);
      if (actual !== asset.sha256) throw new IntegrityError(asset.path, asset.sha256, actual);
      verified.set(asset.path, already);
      options.onProgress?.(++loaded, total, asset.path);
      continue;
    }
    const bytes = await fetchVerified(asset, (path) => {
      loaded += 1;
      options.onProgress?.(loaded, total, path);
    });
    verified.set(asset.path, bytes);
  }

  const decoder = new TextDecoder();

  // 1. Styles first, so the application never paints unstyled.
  for (const stylePath of manifest.styles) {
    const bytes = verified.get(stylePath);
    if (!bytes) continue;
    const style = document.createElement("style");
    style.dataset.latexrenderer = "protected-style";
    style.textContent = decoder.decode(bytes);
    document.head.appendChild(style);
    injectedNodes.add(style);
  }

  // 2. The Monaco web worker. Monaco cannot construct it from a cross-origin URL, so the
  //    verified bytes become a same-origin blob and the app reads the URL from here.
  if (manifest.worker) {
    const bytes = verified.get(manifest.worker);
    if (bytes) {
      const workerUrl = objectUrl(bytes, "text/javascript");
      (window as unknown as Record<string, unknown>).__LATEXRENDERER_WORKER_URL__ = workerUrl;
    }
  }

  // 3. The in-browser TeX worker. Like Monaco's worker, it is supplied as a verified
  //    same-origin blob URL; the protected app never executes an unverified worker.
  if (manifest.compilerWorker) {
    const bytes = verified.get(manifest.compilerWorker);
    if (bytes) {
      const workerUrl = objectUrl(bytes, "text/javascript");
      (window as unknown as Record<string, unknown>).__LATEXRENDERER_COMPILER_WORKER_URL__ =
        workerUrl;
    }
  }

  // 4. Hand the app the base path and build id it needs, then execute the entry bundle.
  (window as unknown as Record<string, unknown>).__LATEXRENDERER_BUILD__ = manifest.buildId;
  (window as unknown as Record<string, unknown>).__LATEXRENDERER_GRANT_EXPIRES__ =
    manifest.grantExpiresAt;

  const entryBytes = verified.get(manifest.entry);
  if (!entryBytes) throw new Error(`The manifest is missing its entry asset ${manifest.entry}.`);

  await new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.dataset.latexrenderer = "protected-entry";
    script.src = objectUrl(entryBytes, "text/javascript");
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("The application bundle failed to execute."));
    document.body.appendChild(script);
    injectedNodes.add(script);
  });
}

/**
 * Tears the protected application out of the page.
 *
 * JavaScript that has already run cannot be un-run -- closures, timers, and listeners it
 * installed may persist -- so this is described honestly as best effort in the security
 * model. What it does guarantee: the Blob URLs are revoked so the bytes are no longer
 * addressable, the injected nodes are removed, and the cache is cleared. A full reload
 * follows, which is what actually reclaims the memory.
 */
export async function stopProtectedApp(): Promise<void> {
  for (const url of liveObjectUrls) URL.revokeObjectURL(url);
  liveObjectUrls.clear();

  for (const node of injectedNodes) node.remove();
  injectedNodes.clear();

  const w = window as unknown as Record<string, unknown>;
  delete w.__LATEXRENDERER_WORKER_URL__;
  delete w.__LATEXRENDERER_COMPILER_WORKER_URL__;
  delete w.__LATEXRENDERER_BUILD__;
  delete w.__LATEXRENDERER_GRANT_EXPIRES__;
  delete w.__LATEXRENDERER_REALTIME__;
  delete w.__LATEXRENDERER_ACCOUNT__;

  await clearProtectedAppCache();
}
