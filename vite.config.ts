import { defineConfig } from "vite";
import { copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The site is served from https://julianattemptscoding.github.io/LaTeXRenderer/, so every
 * emitted asset URL must carry the /LaTeXRenderer/ prefix. `base` is overridable for local
 * preview and for anyone who forks the project under a different repository name.
 */
const base = process.env.VITE_BASE_PATH ?? "/LaTeXRenderer/";

/**
 * GitHub Pages serves 404.html for any path it cannot map to a file. Copying the built
 * index.html to 404.html makes a direct navigation to a deep link -- or a refresh after
 * the OAuth redirect -- render the app instead of GitHub's error page.
 *
 * The shell additionally uses hash routing, so this is belt and braces: the hash form
 * never needs the fallback, and the fallback covers anyone who types a path by hand.
 */
function pagesFallback() {
  return {
    name: "underrock-pages-404-fallback",
    closeBundle() {
      const index = resolve(__dirname, "dist/index.html");
      if (existsSync(index)) {
        copyFileSync(index, resolve(__dirname, "dist/404.html"));
      }
      // .nojekyll stops GitHub Pages from stripping files that begin with an underscore.
      const nojekyll = resolve(__dirname, "dist/.nojekyll");
      if (!existsSync(nojekyll)) {
        copyFileSync(resolve(__dirname, "public/.nojekyll"), nojekyll);
      }
    },
  };
}

export default defineConfig({
  base,
  plugins: [pagesFallback()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // No source maps in the published shell: they would ship the original TypeScript to
    // every visitor for no benefit on a page this small.
    sourcemap: false,
    target: "es2022",
    rollupOptions: {
      output: {
        entryFileNames: "assets/shell-[hash].js",
        chunkFileNames: "assets/shell-[hash].js",
        assetFileNames: "assets/shell-[hash][extname]",
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
});
