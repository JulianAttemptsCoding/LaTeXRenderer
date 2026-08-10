import { defineConfig } from "vite";
import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Relative base, on purpose.
 *
 * "./" makes every emitted asset URL relative to the page that loads it, so exactly the
 * same build works at
 *
 *     https://julianattemptscoding.github.io/LaTeXRenderer/     (project site)
 *     https://julianattemptscoding.github.io/                   (user site, if that repo
 *                                                                is ever created)
 *     http://localhost:4173/                                    (preview)
 *
 * with no rebuild and no environment variable. A hard-coded "/LaTeXRenderer/" would break
 * the moment the repository is renamed -- which has already happened once on this project.
 *
 * This works because the shell is a single page: there are no nested routes whose depth
 * would change how "./assets/…" resolves. VITE_BASE_PATH still overrides it for anyone who
 * needs an absolute base.
 */
const base = process.env.VITE_BASE_PATH ?? "./";

/**
 * GitHub Pages serves 404.html for any path it cannot map to a file.
 *
 * The obvious trick is to copy index.html there so a deep link boots the app. That is
 * WRONG for this build: assets are referenced relatively, so at /LaTeXRenderer/a/b/ the
 * browser would look for /LaTeXRenderer/a/b/assets/... and get nothing. The page would
 * render blank, which is worse than an error.
 *
 * It is also unnecessary. The shell is a single view driven by a state machine -- there
 * are no routes, and the OAuth redirect returns to the base path, which is a real file.
 * So 404.html is a genuine, self-contained error page: no external assets, no JavaScript
 * required to read it, and a link home computed at runtime for the common case of a
 * mistyped path under a project site.
 */
const NOT_FOUND_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>Page not found — LaTeXRenderer</title>
    <style>
      :root { color-scheme: light; --fg: #1a1a18; --muted: #6b6b66; --bg: #f7f7f5; --accent: #1d4ed8; }
      body {
        margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 2rem;
        background: var(--bg); color: var(--fg);
        font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        line-height: 1.55; text-align: center;
      }
      main { max-width: 32rem; display: grid; gap: 0.75rem; }
      h1 { margin: 0; font-size: 1.4rem; font-weight: 640; letter-spacing: -0.02em; }
      p { margin: 0; color: var(--muted); }
      a { color: var(--accent); }
      code { font-family: ui-monospace, Consolas, monospace; font-size: 0.85em; }
    </style>
  </head>
  <body>
    <main>
      <h1>That page does not exist</h1>
      <p>LaTeXRenderer is a single page, so there are no sub-pages to link to.</p>
      <p><a id="home" href="/">Go to LaTeXRenderer</a></p>
    </main>
    <script>
      // On a project site the app lives one segment down (/LaTeXRenderer/). On a user site
      // it lives at the root. Guess from the current path, and fall back to "/" -- which is
      // also what the link already says if this script never runs.
      (function () {
        var seg = location.pathname.split('/').filter(Boolean);
        var home = seg.length > 1 ? '/' + seg[0] + '/' : '/';
        document.getElementById('home').setAttribute('href', home);
      })();
    </script>
  </body>
</html>
`;

function pagesFallback() {
  return {
    name: "latexrenderer-pages-404",
    closeBundle() {
      writeFileSync(resolve(__dirname, "dist/404.html"), NOT_FOUND_HTML);
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
