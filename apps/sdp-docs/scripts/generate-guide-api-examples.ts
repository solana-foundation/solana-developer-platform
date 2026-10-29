import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apiReferenceSchema } from "@sdp/api-catalog/reference";
import { buildSnippets } from "@sdp/api-catalog/snippets";
import type { Parent, RootContent } from "mdast";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { apiExampleOf, type GuideApiExamples } from "@/lib/api-example";
import { isPageSourcePublished, publicSurface } from "@/lib/release-channel";
import { canonicalSite } from "@/lib/site";

const docsDir = fileURLToPath(new URL("../content/docs/", import.meta.url));
const referencePath = fileURLToPath(
  new URL("../../sdp-api/generated/api-reference.json", import.meta.url)
);
const outputPath = fileURLToPath(new URL("../src/generated/api-examples.json", import.meta.url));
const parser = unified().use(remarkParse).use(remarkMdx);

async function mdxFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map((entry) => {
      const fullPath = path.join(dir, entry.name);
      return entry.isDirectory() ? mdxFiles(fullPath) : Promise.resolve([fullPath]);
    })
  );
  return paths.flat().filter((file) => file.endsWith(".mdx"));
}

function operationsIn(source: string, where: string): Set<string> {
  const names = new Set<string>();
  const walk = (parent: Parent) => {
    for (const child of parent.children) {
      const directive = apiExampleOf(child as RootContent, where);
      if (directive) names.add(directive.operation);
      if ("children" in child) walk(child);
    }
  };
  walk(parser.parse(source));
  return names;
}

async function main(): Promise<void> {
  const reference = apiReferenceSchema.parse(JSON.parse(await fs.readFile(referencePath, "utf8")));
  const publicOperations = reference.families.flatMap((family) => family.operations);
  const operations = new Map(
    publicOperations.map((operation) => [operation.endpointId, operation] as const)
  );
  if (operations.size !== publicOperations.length) {
    throw new Error("Public API reference has duplicate endpoint IDs");
  }
  const files = await mdxFiles(docsDir);
  const used = new Set<string>();

  for (const file of files) {
    const source = await fs.readFile(file, "utf8");
    if (!isPageSourcePublished(source, file)) continue;
    for (const name of operationsIn(source, file)) used.add(name);
  }

  const examples: GuideApiExamples = {
    releaseChannel: publicSurface.releaseChannel,
    operations: {},
  };
  for (const name of [...used].sort()) {
    const operation = operations.get(name);
    if (operation === undefined) {
      throw new Error(
        `<ApiExample operation="${name}" /> is not in the ${publicSurface.releaseChannel} public API`
      );
    }
    examples.operations[name] = {
      snippets: buildSnippets({
        method: operation.method,
        url: `${canonicalSite.apiUrl}${operation.request.path}`,
        body: operation.request.body,
        auth: operation.auth,
        takesIdempotencyKey: operation.takesIdempotencyKey,
      }),
    };
  }

  await fs.writeFile(outputPath, `${JSON.stringify(examples, null, 2)}\n`, "utf8");
  console.log(`Generated ${used.size} guide API examples for ${publicSurface.releaseChannel}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
