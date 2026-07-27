import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { build as esbuild } from "esbuild";
import { defineConfig, type Plugin } from "vite";

/**
 * THE AUDIOWORKLET MUST SHIP AS ONE SELF-CONTAINED FILE, and until this plugin existed it did not.
 *
 * `companionEngine.ts` asks for the worklet with `new URL("../audio/scoopy-worklet.js",
 * import.meta.url)`. Vite honours that by copying the file into `assets/` **verbatim, as a static
 * asset** — it does not follow its imports. And `scoopy-worklet.js` statically imports the 369 KB
 * generated WASM module:
 *
 *     import createScoopyEngine from "./scoopy-engine.js";
 *
 * …which vite therefore never emits. So a production build shipped a 20 KB worklet whose very first
 * line reaches for a file that is not there: `addModule()` rejects, the engine never boots, and the
 * companion is silently mute. **The dev server hid this completely**, because it happily serves
 * `/src/audio/scoopy-engine.js` on request. Every gate we had ran against the dev server, so every
 * gate was green. (`browser_prod_test.mjs` now runs against the built bundle, for exactly this
 * reason.)
 *
 * Bundling also removes a portability hazard that had nothing to do with vite: a worklet that relies
 * on `import` needs module-script support inside `AudioWorkletGlobalScope`, which is not something to
 * bet a shipped build on across browsers. With the engine inlined, the worklet has no imports at all.
 *
 * ⚠️ It rewrites the ALREADY-EMITTED asset rather than emitting a new one, deliberately: that keeps
 * vite's own hashed filename and the `new URL(...)` reference that points at it, so no application
 * code has to know this happened.
 */
function selfContainedWorklet(): Plugin {
  return {
    name: "scoopy-self-contained-worklet",
    apply: "build",
    async generateBundle(_options, bundle) {
      const key = Object.keys(bundle).find((k) => /scoopy-worklet.*\.js$/.test(k));
      if (!key) {
        // Not a warning — a hard stop. A build with no worklet in it is a build that cannot make a
        // sound, and that must never leave the machine looking successful.
        this.error(
          "no scoopy-worklet asset in the bundle — the AudioWorklet would be missing from the build",
        );
        return;
      }

      const out = await esbuild({
        entryPoints: [resolve(__dirname, "src/audio/scoopy-worklet.js")],
        bundle: true,
        format: "esm",
        target: "es2022",
        platform: "browser",
        write: false,
        // The WASM is already embedded in scoopy-engine.js (-sSINGLE_FILE=1), so "bundle" here means
        // one file containing the entire engine. It is large, and it is supposed to be.
        logLevel: "silent",
        plugins: [
          {
            // Emscripten's glue is built with `-sENVIRONMENT=web,worker,node` so the SAME module can
            // be driven by the node harnesses (wasm_smoke, the null test). That makes it statically
            // `import` node builtins, which esbuild cannot resolve for a browser target. The code
            // behind them is dead here (it is guarded by ENVIRONMENT_IS_NODE), so it is stubbed
            // rather than dropping node from the emscripten build and breaking the harnesses.
            name: "stub-node-builtins",
            setup(b) {
              b.onResolve({ filter: /^(node:)?(module|fs|path|url|crypto|worker_threads)$/ }, (a) => ({
                path: a.path,
                namespace: "node-stub",
              }));
              b.onLoad({ filter: /.*/, namespace: "node-stub" }, () => ({
                contents: "export default {}; export const createRequire = () => () => ({});",
                loader: "js",
              }));
            },
          },
        ],
      });

      const code = out.outputFiles[0]?.text;
      if (!code) {
        this.error("esbuild produced no worklet output");
        return;
      }
      if (/(^|\n)\s*import\s/.test(code)) {
        // The whole point. If an import survived, the worklet is not self-contained and will fail in
        // the exact way we are trying to make impossible.
        this.error("the bundled worklet still contains an `import` — it is not self-contained");
        return;
      }

      const asset = bundle[key]!;
      if (asset.type !== "asset") {
        this.error(`${key} is a chunk, not an asset — the worklet emit strategy changed`);
        return;
      }
      asset.source = code;
    },
  };
}

// Served by the mac app's WKWebView: DEBUG builds load http://localhost:5173
// (this dev server), RELEASE builds load the bundled dist/ via a custom
// URL scheme handler. Keep base relative so bundled assets resolve.
//
// SL_LAN=1 (dev:lan / preview:lan) exposes the server on the LAN over HTTPS
// for on-device mobile testing: OPFS and the AudioWorklet require a secure
// context, and http://<LAN-ip> is not one (localhost is — which is why the
// mac WKWebView path must stay plain HTTP and this is env-gated).
const lan = !!process.env.SL_LAN;

export default defineConfig({
  plugins: [react(), selfContainedWorklet(), ...(lan ? [basicSsl()] : [])],
  base: "./",
  server: { port: 5173, strictPort: true, host: lan ? true : undefined },
  preview: { port: 5173, strictPort: true },
  build: { target: "es2022", sourcemap: true },
});
