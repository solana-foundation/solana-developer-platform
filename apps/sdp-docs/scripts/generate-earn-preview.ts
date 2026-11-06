import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apiReferenceSchema } from "@sdp/api-catalog/reference";
import { z } from "zod";
import { operationGroups, renderFamilyIndex, renderOperationPage } from "./lib/api-reference-page";
import { slugify } from "./lib/public-openapi.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const input = path.resolve(root, "../sdp-api/generated/earn-reference-preview.json");
const output = path.join(root, "content/unpublished/reference/api/earn");
const previewSchema = z.object({
  reference: apiReferenceSchema,
  partnerOperationIds: z.array(z.string()),
});

/** Renders private authoring copies with the same renderer as the public reference. */
async function main(): Promise<void> {
  const { reference, partnerOperationIds } = previewSchema.parse(
    JSON.parse(await fs.readFile(input, "utf8"))
  );
  const family = reference.families.find((candidate) => candidate.name === "Earn");
  if (!family || reference.families.length !== 1) {
    throw new Error("The Earn preview must contain exactly the Earn family");
  }
  const partnerIds = new Set(partnerOperationIds);
  const groups = operationGroups(family);
  const gated = (source: string) => source.replace(/^---\n/, "---\nmodule: earn\n");
  // This directory is wholly generated and is outside the site's content root.
  await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(
    path.join(output, "index.mdx"),
    gated(
      renderFamilyIndex(family, (operation) => `/docs/reference/api/earn/${operation.endpointId}`)
    ),
    "utf8"
  );
  const pages: string[] = [];
  for (const group of groups) {
    const folder = group.title === null ? "" : `(${slugify(group.title)})`;
    const groupDir = path.join(output, folder);
    await fs.mkdir(groupDir, { recursive: true });
    if (group.title !== null) {
      pages.push(folder);
      await fs.writeFile(
        path.join(groupDir, "meta.json"),
        `${JSON.stringify({ title: group.title, pages: group.operations.map((operation) => operation.endpointId) }, null, 2)}\n`
      );
    }
    for (const operation of group.operations) {
      if (group.title === null) pages.push(operation.endpointId);
      const source = gated(renderOperationPage(operation));
      const note = partnerIds.has(operation.operationId)
        ? ""
        : [
            "",
            '<Callout type="info">',
            "This operation is internal. It is not part of the partner-facing Earn API.",
            "</Callout>",
            "",
          ].join("\n");
      const frontmatterEnd = source.indexOf("\n---", 4) + 4;
      await fs.writeFile(
        path.join(groupDir, `${operation.endpointId}.mdx`),
        source.slice(0, frontmatterEnd) + note + source.slice(frontmatterEnd),
        "utf8"
      );
    }
  }
  await fs.writeFile(
    path.join(output, "meta.json"),
    `${JSON.stringify({ title: "Earn", pages }, null, 2)}\n`
  );
  console.log(`Generated ${family.operations.length} Earn reference drafts outside public docs.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
