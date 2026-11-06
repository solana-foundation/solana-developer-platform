import { fileURLToPath } from "node:url";
import { resetEarnDocsPreview } from "./lib/earn-docs-preview";

resetEarnDocsPreview(fileURLToPath(new URL("../", import.meta.url))).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
