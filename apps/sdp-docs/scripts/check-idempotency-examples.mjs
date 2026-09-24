#!/usr/bin/env node
// Rejects public docs examples that POST to an idempotency-consuming API
// endpoint without showing the Idempotency-Key replay fence (SOLA9-368).
//
// The endpoint set is derived from the generated public OpenAPI document, so
// run `pnpm --filter sdp-docs generate:api` first (the docs build and the
// docs_integrity CI job always do).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  extractIdempotencyPostPaths,
  findMissingIdempotencyKeyExamples,
} from "./lib/idempotency-examples.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const docsContentDir = path.resolve(__dirname, "../content/docs");
const generatedSpecPath = path.resolve(__dirname, "../../sdp-api/generated/openapi.json");

function listMdxFiles(dirPath) {
  return readdirSync(dirPath, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) return listMdxFiles(fullPath);
    return entry.name.endsWith(".mdx") ? [fullPath] : [];
  });
}

if (!existsSync(generatedSpecPath)) {
  console.error(
    `check-idempotency-examples: missing generated OpenAPI document at ${path.relative(process.cwd(), generatedSpecPath)}.\n` +
      "Run `pnpm --filter sdp-docs generate:api` first."
  );
  process.exit(1);
}

const openApiDocument = JSON.parse(readFileSync(generatedSpecPath, "utf8"));
const idempotencyPostPaths = extractIdempotencyPostPaths(openApiDocument);

const files = listMdxFiles(docsContentDir).map((filePath) => ({
  path: path.relative(docsContentDir, filePath),
  source: readFileSync(filePath, "utf8"),
}));

const violations = findMissingIdempotencyKeyExamples({ files, idempotencyPostPaths });

if (violations.length === 0) {
  console.log(
    `check-idempotency-examples: ${files.length} docs pages clean — every example POSTing to one of the ${idempotencyPostPaths.size} idempotency-consuming endpoints shows the Idempotency-Key fence.`
  );
  process.exit(0);
}

console.error(
  "check-idempotency-examples: public examples POST to idempotency-consuming endpoints without the Idempotency-Key replay fence.\n" +
    "An unchanged retry without the key creates a new value-moving operation instead of replaying the original (SOLA9-368). " +
    "Add an Idempotency-Key header to each example and state that retries must reuse it:\n"
);
for (const violation of violations) {
  console.error(`  ${violation.file}:${violation.line} — POST ${violation.endpoint}`);
}
process.exit(1);
