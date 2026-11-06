import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { API_KEY_GRANTABLE_ACTIONS, actionsInModule, actionVerbOf } from "@sdp/types/actions";
import { buildApiReference } from "@/openapi/reference";
import { createOpenApiDocument, createPublicOpenApiDocument } from "@/openapi/spec";

// Authoring output only. Never write the public document or its surface manifest.
const document = createOpenApiDocument();
for (const [route, item] of Object.entries(document.paths)) {
  if (!route.startsWith("/v1/earn/") || !item) continue;
  for (const method of ["get", "post", "put", "patch", "delete"] as const) {
    const operation = item[method];
    if (!operation) continue;
    if (!operation.security?.some((requirement) => "apiKeyAuth" in requirement)) {
      throw new Error(`${method.toUpperCase()} ${route} has no API-key authentication branch`);
    }
    // The shared reference models API-key auth. Internal routes also accept
    // dashboard sessions; render their verified API-key branch for this draft.
    operation.security = [{ apiKeyAuth: [] }];
  }
}
const internal = buildApiReference({
  ...document,
  paths: Object.fromEntries(
    Object.entries(document.paths).filter(([route]) => route.startsWith("/v1/earn/"))
  ),
  tags: document.tags?.filter((tag) => tag.name === "Earn"),
});
const partnerDocument = createPublicOpenApiDocument({
  releaseChannel: "experimental",
  publishEarn: true,
});
const partner = buildApiReference(partnerDocument);
const family = internal.families.find((candidate) => candidate.name === "Earn");
if (!family) throw new Error("The internal OpenAPI document has no Earn family");

const partnerOperationIds = partner.families
  .filter((candidate) => candidate.name === "Earn")
  .flatMap((candidate) => candidate.operations.map((operation) => operation.operationId));
const partnerFamily = partner.families.find((candidate) => candidate.name === "Earn");
if (!partnerFamily) throw new Error("The prospective public OpenAPI document has no Earn family");
const outputDir = path.resolve(process.cwd(), "generated");
await mkdir(outputDir, { recursive: true });
await writeFile(
  path.join(outputDir, "earn-reference-preview.json"),
  `${JSON.stringify(
    {
      reference: { families: [family] },
      partnerOperationIds,
      partner: {
        reference: { families: [partnerFamily] },
        // Build-only input, never served by the API or copied into public artifacts.
        document: {
          ...partnerDocument,
          paths: Object.fromEntries(
            Object.entries(partnerDocument.paths).filter(([route]) => route.startsWith("/v1/earn/"))
          ),
          tags: partnerDocument.tags?.filter((tag) => tag.name === "Earn"),
        },
        grantableActions: {
          module: "earn",
          verbs: actionsInModule("earn")
            .filter((action) => API_KEY_GRANTABLE_ACTIONS.includes(action))
            .map(actionVerbOf),
        },
      },
    },
    null,
    2
  )}\n`,
  "utf8"
);
console.log(`Prepared ${family.operations.length} internal Earn operations for docs review.`);
