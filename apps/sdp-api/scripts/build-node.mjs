/* biome-ignore-all lint/security/noSecrets: file contains the esbuild banner template, which trips the high-entropy heuristic */
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import esbuild from "esbuild";

/**
 * WASM binaries that must sit BESIDE the bundle.
 *
 * esbuild inlines JavaScript, but a wasm-bindgen module loads its binary at
 * MODULE SCOPE with `readFileSync(path.join(__dirname, "<name>.wasm"))`. After
 * bundling, `__dirname` is the output directory — `/app` in the runner image,
 * which ships `dist/` alone with no `node_modules` — so without this the API
 * dies ON STARTUP, not on first use, with
 * `ENOENT: ... orca_whirlpools_core_js_bindings_bg.wasm`.
 *
 * The dependency is transitive and non-obvious: `@sdp/kamino` →
 * `@kamino-finance/klend-sdk` → `@orca-so/whirlpools-core`. Nothing in the API
 * imports Orca directly.
 *
 * Resolved by walking that chain rather than hard-coding a path, because pnpm's
 * strict layout does not expose a transitive package to `apps/sdp-api` and the
 * `.pnpm` directory name carries a version hash. A version bump therefore moves
 * the file and this still finds it — or fails the BUILD, loudly, instead of the
 * container at boot.
 */
function resolveOrcaWasm() {
  // Anchor on the workspace package that actually depends on klend-sdk.
  const kaminoAnchor = path.resolve("../../packages/sdp-kamino/package.json");
  const klend = createRequire(kaminoAnchor).resolve("@kamino-finance/klend-sdk");
  const orca = createRequire(klend).resolve("@orca-so/whirlpools-core");
  return path.join(path.dirname(orca), "orca_whirlpools_core_js_bindings_bg.wasm");
}

/**
 * Resolve bigint-buffer's browser build, which is its pure-JavaScript
 * implementation and never attempts to load the vulnerable native binding.
 *
 * The package is transitive, so walk the real klend -> Raydium -> buffer-layout
 * dependency path instead of relying on pnpm hoisting. If that graph moves, the
 * build fails here and the dependency-boundary check must be reviewed too.
 */
function resolveSafeBigintBuffer() {
  const kaminoAnchor = path.resolve("../../packages/sdp-kamino/package.json");
  const klend = createRequire(kaminoAnchor).resolve("@kamino-finance/klend-sdk");
  const raydium = createRequire(klend).resolve("@raydium-io/raydium-sdk-v2");
  const bufferLayoutUtils = createRequire(raydium).resolve("@solana/buffer-layout-utils");
  return createRequire(bufferLayoutUtils).resolve("bigint-buffer/dist/browser.js");
}

// CJS interop banner for ESM output: pg and other native-backed deps still
// reach for require/__filename/__dirname even when bundled as ESM.
const banner =
  "import{createRequire as __cr}from'module';" +
  "import{fileURLToPath as __furl}from'url';" +
  "import __path from'path';" +
  "const require=__cr(import.meta.url);" +
  "const __filename=__furl(import.meta.url);" +
  "const __dirname=__path.dirname(__filename);";

// migrate.js lets the prebuilt image apply migrations without the source tree.
const entryPoints = {
  server: "src/server.ts",
  job: "src/job.ts",
  migrate: "scripts/migrate-postgres.mjs",
  // custody-backfill.js re-encrypts legacy custody rows to KMS envelopes from the prebuilt image.
  "custody-backfill": "scripts/migrate-custody-encryption.ts",
  // counterparty-pii-migrate.js performs the gated PII backfill/cutover lifecycle.
  "counterparty-pii-migrate": "scripts/counterparty-pii-migrate.ts",
  // configure.js generates a self-hosted .env in the terminal from the prebuilt image.
  configure: "scripts/configure.ts",
};

await esbuild.build({
  entryPoints,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outdir: "dist",
  external: ["pg-native", "@sentry/profiling-node"],
  // bigint-buffer@1.1.5 has no patched release. Its browser entry is the
  // package's pure-JS implementation, so execution can be registered without
  // placing the vulnerable native loader in any API artifact.
  alias: { "bigint-buffer": resolveSafeBigintBuffer() },
  banner: { js: banner },
});

// klend-sdk's dependency graph declares bigint-buffer@1.1.5, whose native
// binding has GHSA-3gc7-fjrx-p6mg and no patched release. The alias above forces
// its pure-JS browser implementation. Keep that replacement honest: fail the
// build if a future graph change pulls the native loader into ANY shipped
// JavaScript entry point.
for (const entryPoint of Object.keys(entryPoints)) {
  const output = path.join("dist", `${entryPoint}.js`);
  // The safe browser implementation can retain a harmless generated variable
  // named `bigint_buffer_1`; match the native entry's unique warning instead
  // of rejecting that identifier.
  if (readFileSync(output, "utf8").includes("Failed to load bindings, pure JS will be used")) {
    throw new Error(
      `${output} contains bigint-buffer's vulnerable native binding loader ` +
        "(GHSA-3gc7-fjrx-p6mg). Remove or replace that runtime path before shipping it."
    );
  }
}

const wasmSource = resolveOrcaWasm();
if (!existsSync(wasmSource)) {
  throw new Error(
    `Expected the Orca wasm binary at ${wasmSource}. klend-sdk loads it at module scope, so a ` +
      "missing file here means the built image dies on startup. Check whether " +
      "@orca-so/whirlpools-core moved or renamed it."
  );
}
copyFileSync(wasmSource, path.join("dist", path.basename(wasmSource)));
