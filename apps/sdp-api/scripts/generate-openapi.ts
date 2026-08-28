import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createPublicOpenApiDocument } from "../src/openapi/spec";

const document = createPublicOpenApiDocument();

const outputDir = path.resolve(process.cwd(), "generated");
const outputPath = path.join(outputDir, "openapi.json");

await mkdir(outputDir, { recursive: true });
await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");

console.log(`OpenAPI spec generated at ${outputPath}`);
