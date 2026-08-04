// Regenerates the committed advanced-settings support matrix.
// Run: `pnpm --filter @sdp/issuance matrix:generate`
//
// The drift test (capabilities.test.ts) fails if the committed file is stale, so
// run this whenever the catalog or capability registry changes.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderSupportMatrixMarkdown } from "../src/capabilities/support-matrix";

const target = fileURLToPath(new URL("../src/capabilities/SUPPORT_MATRIX.md", import.meta.url));

writeFileSync(target, renderSupportMatrixMarkdown(), "utf8");
console.log(`Wrote ${target}`);
