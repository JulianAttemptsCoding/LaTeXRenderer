import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IntegrityError,
  clearProtectedAppCache,
  sha256Hex,
  startProtectedApp,
  stopProtectedApp,
  type ManifestAsset,
  type ProtectedManifest,
} from "../../src/lib/protectedApp";

const encoder = new TextEncoder();

async function asset(
  path: string,
  content: string,
  overrides: Partial<ManifestAsset> = {},
): Promise<{ asset: ManifestAsset; bytes: ArrayBuffer }> {
  const bytes = encoder.encode(content).buffer as ArrayBuffer;
  return {
    bytes,
    asset: {
      path,
      sha256: await sha256Hex(bytes),
      size: bytes.byteLength,
      contentType: path.endsWith(".css") ? "text/css" : "text/javascript",
      url: `https://storage.example.test/${path}`,
      ...overrides,
    },
  };
}

function manifestOf(assets: ManifestAsset[], entry = "app.js"): ProtectedManifest {
  return {
    ok: true,
    buildId: "testbuild01",
    entry,
    styles: assets.filter((a) => a.path.endsWith(".css")).map((a) => a.path),
    worker: assets.find((a) => a.path === "editor.worker.js")?.path ?? null,
    expiresInSeconds: 300,
    grantExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    assets,
  };
}

/** Serves the exact bytes each asset URL is supposed to carry, or tampered ones. */
function stubFetch(bodies: Map<string, ArrayBuffer>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = bodies.get(url);
    if (!body) return new Response(null, { status: 404 });
    return new Response(body, { status: 200 });
  });
}

describe("sha256Hex", () => {
  it("matches the known digest of the empty input", async () => {
    const digest = await sha256Hex(new ArrayBuffer(0));
    expect(digest).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("matches the known digest of 'abc'", async () => {
    const digest = await sha256Hex(encoder.encode("abc").buffer as ArrayBuffer);
    expect(digest).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("startProtectedApp", () => {
  beforeEach(async () => {
    document.head.replaceChildren();
    document.body.replaceChildren();
    await clearProtectedAppCache();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await stopProtectedApp();
  });

  it("executes a bundle whose hash matches the manifest", async () => {
    const entry = await asset("app.js", "globalThis.__ran__ = true;");
    const style = await asset("app.css", "body{color:red}");
    const bodies = new Map([
      [entry.asset.url, entry.bytes],
      [style.asset.url, style.bytes],
    ]);
    vi.stubGlobal("fetch", stubFetch(bodies));

    // jsdom does not execute blob: script src, so onload is driven manually.
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLScriptElement) node.dispatchEvent(new Event("load"));
        }
      }
    });
    observer.observe(document.body, { childList: true });

    await startProtectedApp(manifestOf([entry.asset, style.asset]));
    observer.disconnect();

    expect(document.querySelector('script[data-latexrenderer="protected-entry"]')).toBeTruthy();
    expect(document.querySelector('style[data-latexrenderer="protected-style"]')?.textContent)
      .toBe("body{color:red}");
    expect(
      (window as unknown as Record<string, unknown>).__LATEXRENDERER_BUILD__,
    ).toBe("testbuild01");
  });

  it("refuses to execute a tampered bundle", async () => {
    const entry = await asset("app.js", "globalThis.__ran__ = true;");
    const tampered = encoder.encode("globalThis.__pwned__ = true;").buffer as ArrayBuffer;
    vi.stubGlobal("fetch", stubFetch(new Map([[entry.asset.url, tampered]])));

    await expect(startProtectedApp(manifestOf([entry.asset]))).rejects.toBeInstanceOf(
      IntegrityError,
    );
    expect(document.querySelector('script[data-latexrenderer="protected-entry"]')).toBeNull();
    expect((globalThis as Record<string, unknown>).__pwned__).toBeUndefined();
  });

  it("refuses a bundle whose length differs even if the digest were forced to match", async () => {
    const entry = await asset("app.js", "ok");
    // Same declared hash, wrong declared size.
    const lying: ManifestAsset = { ...entry.asset, size: entry.asset.size + 10 };
    vi.stubGlobal("fetch", stubFetch(new Map([[entry.asset.url, entry.bytes]])));

    await expect(startProtectedApp(manifestOf([lying]))).rejects.toBeInstanceOf(IntegrityError);
  });

  it("injects nothing at all when a later asset fails verification", async () => {
    const entry = await asset("app.js", "globalThis.__ran__ = true;");
    const style = await asset("app.css", "body{color:red}");
    const bodies = new Map([
      [entry.asset.url, entry.bytes],
      [style.asset.url, encoder.encode("body{color:blue}").buffer as ArrayBuffer],
    ]);
    vi.stubGlobal("fetch", stubFetch(bodies));

    await expect(
      startProtectedApp(manifestOf([entry.asset, style.asset])),
    ).rejects.toBeInstanceOf(IntegrityError);

    // The point of verifying everything before injecting anything.
    expect(document.querySelector("style[data-latexrenderer]")).toBeNull();
    expect(document.querySelector("script[data-latexrenderer]")).toBeNull();
  });

  it("reports a download failure without executing anything", async () => {
    const entry = await asset("app.js", "x");
    vi.stubGlobal("fetch", stubFetch(new Map()));
    await expect(startProtectedApp(manifestOf([entry.asset]))).rejects.toThrow(/HTTP 404/);
  });

  it("exposes the worker URL as a same-origin blob rather than the signed URL", async () => {
    const entry = await asset("app.js", "1;");
    const worker = await asset("editor.worker.js", "self.onmessage=()=>{};");
    vi.stubGlobal(
      "fetch",
      stubFetch(new Map([
        [entry.asset.url, entry.bytes],
        [worker.asset.url, worker.bytes],
      ])),
    );
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLScriptElement) node.dispatchEvent(new Event("load"));
        }
      }
    });
    observer.observe(document.body, { childList: true });

    await startProtectedApp(manifestOf([entry.asset, worker.asset]));
    observer.disconnect();

    const url = (window as unknown as Record<string, unknown>).__LATEXRENDERER_WORKER_URL__;
    expect(String(url)).toMatch(/^blob:/);
    expect(String(url)).not.toContain("storage.example.test");
  });
});

describe("stopProtectedApp", () => {
  it("removes injected nodes and the globals the app relies on", async () => {
    const entry = await asset("app.js", "1;");
    vi.stubGlobal("fetch", stubFetch(new Map([[entry.asset.url, entry.bytes]])));
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLScriptElement) node.dispatchEvent(new Event("load"));
        }
      }
    });
    observer.observe(document.body, { childList: true });
    await startProtectedApp(manifestOf([entry.asset]));
    observer.disconnect();

    await stopProtectedApp();

    expect(document.querySelector("script[data-latexrenderer]")).toBeNull();
    const w = window as unknown as Record<string, unknown>;
    expect(w.__LATEXRENDERER_BUILD__).toBeUndefined();
    expect(w.__LATEXRENDERER_WORKER_URL__).toBeUndefined();
    vi.unstubAllGlobals();
  });
});
