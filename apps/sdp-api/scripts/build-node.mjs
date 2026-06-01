/* biome-ignore-all lint/security/noSecrets: file contains the esbuild banner template, which trips the high-entropy heuristic */
import esbuild from "esbuild";

// CJS interop banner for ESM output: pg and other native-backed deps still
// reach for require/__filename/__dirname even when bundled as ESM.
const banner =
  "import{createRequire as __cr}from'module';" +
  "import{fileURLToPath as __furl}from'url';" +
  "import __path from'path';" +
  "const require=__cr(import.meta.url);" +
  "const __filename=__furl(import.meta.url);" +
  "const __dirname=__path.dirname(__filename);";

await esbuild.build({
  // migrate.js lets the prebuilt image apply migrations without the source tree.
  entryPoints: {
    server: "src/server.ts",
    migrate: "scripts/migrate-postgres.mjs",
    // configure.js generates a self-hosted .env in the terminal from the prebuilt image.
    configure: "scripts/configure.ts",
  },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outdir: "dist",
  external: ["pg-native", "@sentry/profiling-node"],
  banner: { js: banner },
});
