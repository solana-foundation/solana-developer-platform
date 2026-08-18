// biome-ignore-all lint/security/noSecrets: public Solana program ID, not a secret.
/**
 * Generate the Private Channels escrow `@solana/kit` client from the vendored
 * Codama rootNode IDL. JS renderer only: the program repository also renders Rust,
 * and only the TS client is needed here.
 *
 * Run: `pnpm --filter @sdp/spc-escrow generate`
 * Re-run whenever `idl/private_channel_escrow_program.json` is re-vendored.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderVisitor as renderJavaScriptVisitor } from "@codama/renderers-js";
import { createFromJson } from "codama";
import {
  appendAccountDiscriminator,
  appendPdaDerivers,
  overrideProgramId,
  removeEmitInstruction,
  setInstructionAccountDefaultValues,
  updateInstructionBumps,
} from "./codama-updates";

// The REAL deployed escrow program (devnet). The IDL declares the placeholder
// `GokvZqD2…`; mirror of `SANDBOX_DEFAULTS.escrowProgramId` in `@sdp/private-channels`.
const ESCROW_PROGRAM_ID = "9tgHa1DcnaSSUtmMsst8ovKTe1Gfxzezn27KnH9xXYeU";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const idlPath = join(packageRoot, "idl", "private_channel_escrow_program.json");
const generatedDir = join(packageRoot, "src", "generated");

const idl = readFileSync(idlPath, "utf-8");
const codama = createFromJson(idl);

overrideProgramId(codama, ESCROW_PROGRAM_ID);
appendAccountDiscriminator(codama);
appendPdaDerivers(codama);
setInstructionAccountDefaultValues(codama, ESCROW_PROGRAM_ID);
updateInstructionBumps(codama);
removeEmitInstruction(codama);

codama.accept(
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

console.log(`Generated escrow client → ${generatedDir} (program ${ESCROW_PROGRAM_ID})`);
