// biome-ignore-all lint/security/noSecrets: public Solana program ID, not a secret.
/**
 * Generate the Private Channels withdraw `@solana/kit` client from the vendored
 * Codama rootNode IDL. JS renderer only: the program repository also renders Rust,
 * and only the TS client is needed here.
 *
 * Unlike escrow, the withdraw IDL already declares the REAL deployed program id
 * (`J231K9…`), so there is no program-id override step here.
 *
 * Run: `pnpm --filter @sdp/spc-withdraw generate`
 * Re-run whenever `idl/private_channel_withdraw_program.json` is re-vendored.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderVisitor as renderJavaScriptVisitor } from "@codama/renderers-js";
import { createFromJson } from "codama";
import { appendAccountDiscriminator, setInstructionAccountDefaultValues } from "./codama-updates";

// The REAL deployed withdraw program (devnet) — already declared in the IDL.
const WITHDRAW_PROGRAM_ID = "J231K9UEpS4y4KAPwGc4gsMNCjKFRMYcQBcjVW7vBhVi";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const idlPath = join(packageRoot, "idl", "private_channel_withdraw_program.json");
const generatedDir = join(packageRoot, "src", "generated");

const idl = readFileSync(idlPath, "utf-8");
const codama = createFromJson(idl);

appendAccountDiscriminator(codama);
setInstructionAccountDefaultValues(codama);

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

console.log(`Generated withdraw client → ${generatedDir} (program ${WITHDRAW_PROGRAM_ID})`);
