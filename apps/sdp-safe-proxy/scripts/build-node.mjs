import { build } from "esbuild";

await build({
  entryPoints: { server: "src/server.ts" },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outdir: "dist",
});
