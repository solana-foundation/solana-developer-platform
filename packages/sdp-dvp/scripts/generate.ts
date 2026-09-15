// biome-ignore-all lint/security/noSecrets: public Solana program ID, not a secret.
/**
 * Generate the DvP swap `@solana/kit` client from the vendored Codama IDL.
 * JS renderer only: the program repository also renders Rust, and only the
 * TypeScript client is needed here.
 *
 * Run: `pnpm --filter @sdp/dvp generate`
 * Re-run whenever `idl/dvp_swap_program.json` is re-vendored.
 *
 * The IDL is vendored from `solana-foundation/dvp` at `origin/dev` (afbfafe),
 * which is the build actually deployed to devnet. Note that `dev` is not the
 * newest program source: `9103afe` ("floor the escrow preload check at 1
 * lamport", #9) is on `main` and not on `dev`, while main's declared program
 * ID is deployed nowhere. We target the deployed one because it is the only
 * one we can call. Tracked in PRO-1798.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderVisitor as renderJavaScriptVisitor } from "@codama/renderers-js";
import { createFromJson } from "codama";
import { setFixedAccountOptionFields, setInstructionAccountDefaultValues } from "./codama-updates";
import { patchSafeNumbers } from "./patch-safe-numbers";

/** The DvP swap program live on devnet (`origin/dev` build). */
const DVP_SWAP_PROGRAM_ID = "dvp34bdbcEm4f4FCUjGV4mDAkDshaQR4LkK8fdcsyZq";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const idlPath = join(packageRoot, "idl", "dvp_swap_program.json");
const generatedDir = join(packageRoot, "src", "generated");

const idl = readFileSync(idlPath, "utf-8");

// Guard the vendored IDL against a silent re-vendor from the wrong branch:
// the program ID is the one thing that differs between main and dev, and
// getting it wrong points every PDA deriver at an undeployed program.
const declaredId = JSON.parse(idl).program?.publicKey;
if (declaredId !== DVP_SWAP_PROGRAM_ID) {
  throw new Error(
    `Vendored IDL declares program ${declaredId}, expected ${DVP_SWAP_PROGRAM_ID}. ` +
      `Re-vendor idl/dvp_swap_program.json from the deployed branch, or update this constant.`
  );
}

const codama = createFromJson(idl);

setInstructionAccountDefaultValues(codama);
setFixedAccountOptionFields(codama);

await codama.accept(
  renderJavaScriptVisitor(generatedDir, {
    formatCode: true,
    // Default appends another `src/generated` under this path; "." writes in place.
    generatedFolder: ".",
    syncPackageJson: false,
    deleteFolderBeforeRendering: true,
    // Import through `@solana/kit` (+ its subpath exports) only, so the client
    // stays on the repo's pinned kit rather than the standalone split packages.
    kitImportStrategy: "rootOnly",
  })
);

patchSafeNumbers(generatedDir);

console.log(`Generated DvP client → ${generatedDir} (program ${DVP_SWAP_PROGRAM_ID})`);
