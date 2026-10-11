// Vite config of the control panel (web/). `pnpm web:build` writes `public/index.html` and `public/assets/*`, which the
// Worker serves at `/` (src/management/web-panel.ts) next to `public/management.html` (the upstream panel, installed by
// `pnpm panel:sync`). `pnpm web:dev` serves the panel with hot reload and forwards `/v8` to a running `pnpm dev` Worker.
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { build, defineConfig, type Plugin } from "vite";

const outDir = fileURLToPath(new URL("../public", import.meta.url));

/** `pnpm dev` Worker the dev server forwards API calls to. */
const workerUrl = process.env["CLIPROXY_DEV_URL"] ?? "http://localhost:1337";

/**
 * `public/` also holds `management.html`, so the build cannot empty its output directory: remove only the previous
 * panel build (stale hashed bundles would otherwise be deployed).
 */
const cleanPreviousBuild = (): Plugin => ({
  name: "cliproxy:clean-previous-build",
  apply: "build",
  async buildStart() {
    await rm(`${outDir}/assets`, { recursive: true, force: true });
    await rm(`${outDir}/index.html`, { force: true });
  },
});

const themeBootEntry = fileURLToPath(new URL("src/theme-boot.ts", import.meta.url));

/** Name of the emitted theme script (`assets/theme-<hash>.js`) and its path on the dev server. */
const THEME_BOOT_ASSET = "theme.js";

const THEME_BOOT_DEV_PATH = "/theme-boot.js";

/** `src/theme-boot.ts` and what it imports as one classic script: an IIFE with no `import` left in it. */
const compileThemeBoot = async () => {
  const result = await build({
    configFile: false,
    logLevel: "warn",
    publicDir: false,
    build: {
      write: false,
      minify: true,
      target: "es2023",
      rolldownOptions: { input: themeBootEntry, output: { format: "iife" } },
    },
  });

  for (const output of Array.isArray(result) ? result : [result]) {
    if (!("output" in output)) continue;

    const chunk = output.output.find((file) => file.type === "chunk");

    if (chunk !== undefined) return chunk.code;
  }

  throw new Error("src/theme-boot.ts built no script");
};

/**
 * The stored theme choice must apply before the first paint, and the CSP (`src/management/web-panel.ts`) allows only
 * same-origin scripts: build `src/theme-boot.ts` separately, emit it under `/assets` (served by the Worker like the
 * rest of the bundle) and load it with a plain, render-blocking `<script src>` at the end of `<head>`, after the
 * metas it updates. A module script would run deferred, after a paint could show the other theme.
 */
const themeBoot = (): Plugin => {
  let building = false;

  return {
    name: "cliproxy:theme-boot",
    configResolved(config) {
      building = config.command === "build";
    },
    async buildStart() {
      if (building)
        this.emitFile({ type: "asset", name: THEME_BOOT_ASSET, source: await compileThemeBoot() });
    },
    configureServer(server) {
      server.middlewares.use(THEME_BOOT_DEV_PATH, (_request, response, next) => {
        compileThemeBoot().then((code) => {
          response.setHeader("content-type", "text/javascript");
          response.end(code);
        }, next);
      });
    },
    transformIndexHtml: {
      order: "post",
      handler(_html, context) {
        if (context.bundle === undefined)
          return [{ tag: "script", attrs: { src: THEME_BOOT_DEV_PATH }, injectTo: "head" }];

        const asset = Object.values(context.bundle).find(
          (file) => file.type === "asset" && file.names.includes(THEME_BOOT_ASSET),
        );

        if (asset === undefined) throw new Error("the theme script was not emitted");

        return [{ tag: "script", attrs: { src: `/${asset.fileName}` }, injectTo: "head" }];
      },
    },
  };
};

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: false,
  plugins: [react(), cleanPreviousBuild(), themeBoot()],
  build: {
    outDir,
    emptyOutDir: false,
    assetsDir: "assets",
    target: "es2023",
    sourcemap: true,
    // Effect, React and the router make one ~165 kB (gzip) bundle; the panel is a single admin page, so it is not split.
    chunkSizeWarningLimit: 800,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // The Worker refuses management calls whose Origin is another host (src/access/csrf.ts); present the Worker's
      // own origin, as the deployed panel does.
      "/v8": {
        target: workerUrl,
        changeOrigin: true,
        headers: { origin: workerUrl },
      },
    },
  },
});
