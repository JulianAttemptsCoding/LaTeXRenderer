import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";

// jsdom ships no SubtleCrypto. The shell's whole integrity guarantee is built on
// crypto.subtle.digest, so the tests must exercise a real implementation rather than a
// stub that could pass while the production path is broken.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    configurable: true,
    writable: true,
  });
}

if (typeof URL.createObjectURL !== "function") {
  let counter = 0;
  const registry = new Map<string, Blob>();
  URL.createObjectURL = (blob: Blob) => {
    const url = `blob:underrock/${++counter}`;
    registry.set(url, blob);
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    registry.delete(url);
  };
}
