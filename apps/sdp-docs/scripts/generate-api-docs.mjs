import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
const rootMetaPath = path.resolve(__dirname, "../content/docs/meta.json");

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
const SOURCE_PATH = "apps/sdp-api/generated/openapi.json";
const escapeTableText = (value) => value.replace(/\|/g, "\\|");

const renderOperationRow = (operation) =>
  `| \`${operation.method}\` | \`${operation.path}\` | ${escapeTableText(operation.summary || "-")} |`;

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
  for (const operation of operations) {
    const primaryTag = getPrimaryTagName(operation);
    if (!primaryTag || !isPublicTag(primaryTag)) {
      continue;
    }

    if (!groupedOperations.has(primaryTag)) {
      groupedOperations.set(primaryTag, []);
    }
    groupedOperations.get(primaryTag).push(operation);
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

  await writeJson(path.join(outputDir, "meta.json"), {
    title: "API",
    pages: ["index", ...tagPages.map((tagPage) => tagPage.slug)],
  });

  // Preserve non-API sections from the existing root meta.json, only replacing
  // the API reference entries (everything after "reference/api/index").
  let existingMeta;
  try {
    existingMeta = JSON.parse(await fs.readFile(rootMetaPath, "utf8"));
  } catch {
    existingMeta = null;
  }

  const apiPages = [
    "reference/api/index",
    ...tagPages.map((tagPage) => `reference/api/${tagPage.slug}`),
  ];

  let newPages;
  if (existingMeta?.pages) {
    // Find where the API reference entries start and replace from there.
    const apiStartIndex = existingMeta.pages.indexOf("reference/api/index");
    if (apiStartIndex !== -1) {
      newPages = [...existingMeta.pages.slice(0, apiStartIndex), ...apiPages];
    } else {
      // No existing API entries — append after the last entry.
      newPages = [...existingMeta.pages, ...apiPages];
    }
  } else {
    newPages = [
      "what-is-solana-developer-platform",
      "getting-started",
      "---Platform Setup---",
      "guides/setup-organization",
      "guides/setup-wallets",
      "guides/manage-api-keys",
      "---Tokens---",
      "guides/tokenize-an-asset",
      "guides/create-a-token",
      "guides/deploy-a-token",
      "guides/mint-and-burn",
      "guides/manage-allowlists",
      "guides/freeze-and-compliance",
      "guides/prepare-vs-execute",
      "reference/issuance-token-types",
      "---Payments---",
      "payments/index",
      "payments/concepts",
      "---Send Payments---",
      "payments/send-basic-payment",
      "payments/send-payment-with-memo",
      "payments/send-payouts",
      "---Accept Payments---",
      "payments/accept-overview",
      "payments/accept-verification",
      "payments/accept-indexing",
      "---Ramps---",
      "payments/ramps",
      "payments/ramps-providers",
      "---Wallet Operations---",
      "payments/wallet-policies",
      "payments/wallet-balances",
      "---Tutorials---",
      "tutorials/end-to-end-payment-flow",
      "---Integrations---",
      "reference/provider-onboarding",
      "reference/ai-consumption",
      "reference/postman-collection",
      "---API---",
      ...apiPages,
    ];
  }

  await writeJson(rootMetaPath, {
    title: existingMeta?.title || "Solana Developer Platform Docs",
    pages: newPages,
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
