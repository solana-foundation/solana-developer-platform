import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { escapeMarkdownTableCell } from "./lib/markdown-escaping.mjs";
import {
  getPrimaryTagName,
  isPublicTag,
  POSTMAN_COLLECTION_ROUTE,
  PUBLIC_TAG_SLUGS,
  slugify,
} from "./lib/public-openapi.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const generatedSpecPath = path.resolve(__dirname, "../../sdp-api/generated/openapi.json");
const outputDir = path.resolve(__dirname, "../content/docs/reference/api");

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
const SOURCE_PATH = "apps/sdp-api/generated/openapi.json";
const renderOperationRow = (operation) =>
  `| \`${operation.method}\` | \`${operation.path}\` | ${escapeMarkdownTableCell(operation.summary || "-")} |`;

const parseJsonSpec = (spec) => {
  const tagDescriptions = new Map();
  for (const tag of spec.tags || []) {
    if (!tag?.name) {
      continue;
    }
    tagDescriptions.set(tag.name, tag.description || "");
  }

  const operations = [];
  const paths = spec.paths || {};

  for (const [routePath, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== "object") {
      continue;
    }

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation || typeof operation !== "object") {
        continue;
      }

      const summary = operation.summary || operation.operationId || "-";
      const tags = Array.isArray(operation.tags)
        ? operation.tags.map((tag) => String(tag)).filter(Boolean)
        : [];

      operations.push({
        method: method.toUpperCase(),
        path: routePath,
        summary,
        tags,
      });
    }
  }

  return { tagDescriptions, operations };
};

const loadSpecData = async () => {
  let json;

  try {
    json = await fs.readFile(generatedSpecPath, "utf8");
  } catch (error) {
    throw new Error(
      `Missing generated OpenAPI spec at ${SOURCE_PATH}. Run "pnpm -C apps/sdp-api run openapi:generate" first.`,
      { cause: error }
    );
  }

  let spec;
  try {
    spec = JSON.parse(json);
  } catch (error) {
    throw new Error(`Invalid JSON in ${SOURCE_PATH}.`, { cause: error });
  }

  const parsed = parseJsonSpec(spec);
  if (parsed.operations.length === 0) {
    throw new Error(`No API operations found in ${SOURCE_PATH}.`);
  }

  return parsed;
};

const renderTagPage = ({ tagName, description, operations }) => {
  const sortedOperations = [...operations].sort((left, right) => {
    if (left.path === right.path) {
      return left.method.localeCompare(right.method);
    }
    return left.path.localeCompare(right.path);
  });

  const rows = sortedOperations.map(renderOperationRow).join("\n");

  return `---
title: ${tagName}
description: ${description || `${tagName} API endpoints`}
---

| Method | Endpoint | Summary |
| --- | --- | --- |
${rows}
`;
};

const renderIndexPage = ({ tagPages }) => {
  const links = tagPages
    .map((tagPage) => `- [${tagPage.title}](/docs/reference/api/${tagPage.slug})`)
    .join("\n");

  return `---
title: API Reference
description: Endpoint index from the repository OpenAPI spec.
---

<div>
  <a href="${POSTMAN_COLLECTION_ROUTE}" download>Download Postman collection</a>
  {" · "}
  <a href="${POSTMAN_COLLECTION_ROUTE}">Open raw JSON</a>
</div>

${links}
`;
};

const writeJson = async (filePath, value) => {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const extractRenderedRows = (content) => {
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");

  return body
    .split(/\r?\n/)
    .filter(
      (line) => line.startsWith("| ") && !line.startsWith("| Method") && !line.startsWith("| ---")
    );
};

const validateGeneratedTagPages = async ({ outputDir, tagPages, groupedOperations }) => {
  const generatedSlugs = new Set(tagPages.map((tagPage) => tagPage.slug));
  const missingPublicPages = [...PUBLIC_TAG_SLUGS].filter((slug) => !generatedSlugs.has(slug));

  if (missingPublicPages.length > 0) {
    throw new Error(
      `Generated API docs are missing required public sections: ${missingPublicPages.join(", ")}`
    );
  }

  for (const tagPage of tagPages) {
    const source = await fs.readFile(path.join(outputDir, `${tagPage.slug}.mdx`), "utf8");
    const actualRows = extractRenderedRows(source);
    const expectedRows = (groupedOperations.get(tagPage.title) || [])
      .slice()
      .sort((left, right) => {
        if (left.path === right.path) {
          return left.method.localeCompare(right.method);
        }
        return left.path.localeCompare(right.path);
      })
      .map(renderOperationRow);

    if (actualRows.length !== expectedRows.length) {
      throw new Error(
        `Generated API docs for ${tagPage.title} document ${actualRows.length} operations, expected ${expectedRows.length}`
      );
    }

    for (const row of expectedRows) {
      if (!actualRows.includes(row)) {
        throw new Error(`Generated API docs for ${tagPage.title} are missing row: ${row}`);
      }
    }
  }
};

const run = async () => {
  const { tagDescriptions, operations } = await loadSpecData();

  const groupedOperations = new Map();
  const unlistedTags = new Set();
  for (const operation of operations) {
    const primaryTag = getPrimaryTagName(operation);
    if (!primaryTag) {
      continue;
    }
    if (!isPublicTag(primaryTag)) {
      unlistedTags.add(primaryTag);
      continue;
    }

    if (!groupedOperations.has(primaryTag)) {
      groupedOperations.set(primaryTag, []);
    }
    groupedOperations.get(primaryTag).push(operation);
  }

  // The spec is the public document, so an unlisted tag is a published family
  // the docs would otherwise drop without a word.
  if (unlistedTags.size > 0) {
    throw new Error(
      `The public OpenAPI document publishes ${[...unlistedTags].join(", ")}, which PUBLIC_TAG_SLUGS in scripts/lib/public-openapi.mjs does not list. Add the slug, or keep the family out of registerPublicPaths in apps/sdp-api/src/openapi/spec.ts.`
    );
  }

  const orderedTags = [];

  for (const knownTag of tagDescriptions.keys()) {
    if (groupedOperations.has(knownTag)) {
      orderedTags.push(knownTag);
    }
  }

  const additionalTags = [...groupedOperations.keys()]
    .filter((tag) => !tagDescriptions.has(tag))
    .sort((left, right) => left.localeCompare(right));

  orderedTags.push(...additionalTags);
  const exposedOperationsCount = [...groupedOperations.values()].reduce(
    (total, operationsInTag) => total + operationsInTag.length,
    0
  );

  await fs.mkdir(outputDir, { recursive: true });

  const existingFiles = await fs.readdir(outputDir);
  await Promise.all(
    existingFiles
      .filter((fileName) => fileName.endsWith(".mdx") || fileName === "meta.json")
      .map((fileName) => fs.rm(path.join(outputDir, fileName), { force: true }))
  );

  const tagPages = [];

  for (const tagName of orderedTags) {
    const tagSlug = slugify(tagName);
    const tagOps = groupedOperations.get(tagName) || [];
    const description = tagDescriptions.get(tagName) || "";

    const tagContent = renderTagPage({
      tagName,
      description,
      operations: tagOps,
    });

    await fs.writeFile(path.join(outputDir, `${tagSlug}.mdx`), tagContent, "utf8");
    tagPages.push({ title: tagName, slug: tagSlug });
  }

  const indexContent = renderIndexPage({
    tagPages,
  });

  await fs.writeFile(path.join(outputDir, "index.mdx"), indexContent, "utf8");

  // The sidebar reaches these pages through "api" in reference/meta.json; the
  // root meta.json is hand-maintained and never lists them.
  await writeJson(path.join(outputDir, "meta.json"), {
    title: "API",
    pages: ["index", ...tagPages.map((tagPage) => tagPage.slug)],
  });

  await validateGeneratedTagPages({
    outputDir,
    tagPages,
    groupedOperations,
  });

  console.log(
    `Generated ${exposedOperationsCount} endpoints across ${tagPages.length} API sections from ${SOURCE_PATH}`
  );
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
