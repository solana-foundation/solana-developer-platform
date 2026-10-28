import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apiReferenceSchema } from "@sdp/api-catalog/reference";
import { renderFamilyPage, SAMPLE_TAB_MARKERS } from "./lib/api-reference-page.ts";
import { POSTMAN_COLLECTION_ROUTE, slugify } from "./lib/public-openapi.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The reference model `openapi:generate` builds from the channel's public OpenAPI document
// (apps/sdp-api/src/openapi/reference.ts), with what that channel publishes beside it. The
// surface is committed at experimental like the other generated docs files.
const generatedReferencePath = path.resolve(
  __dirname,
  "../../sdp-api/generated/api-reference.json"
);
const generatedSurfacePath = path.resolve(__dirname, "../../sdp-api/generated/public-surface.json");
const surfacePath = path.resolve(__dirname, "../src/generated/public-surface.json");
const outputDir = path.resolve(__dirname, "../content/docs/reference/api");
const rootMetaPath = path.resolve(__dirname, "../content/docs/meta.json");

const SOURCE_PATH = "apps/sdp-api/generated/api-reference.json";

const loadReference = async () => {
  let json;
  try {
    json = await fs.readFile(generatedReferencePath, "utf8");
  } catch (error) {
    throw new Error(
      `Missing ${SOURCE_PATH}. Run "pnpm -C apps/sdp-api run openapi:generate" first.`,
      { cause: error }
    );
  }
  return apiReferenceSchema.parse(JSON.parse(json));
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

// Families every release channel runs, so every build must render them.
const ALWAYS_PUBLIC_TAG_SLUGS = ["health", "wallets", "projects"];

/**
 * Every family page holds one section per operation, anchored by its operationId, and each
 * section the three request samples: the reference's coverage, checked on what was written.
 */
const validateGeneratedTagPages = async ({ outputDir, families }) => {
  const generatedSlugs = new Set(families.map((family) => slugify(family.name)));
  const missingPublicPages = ALWAYS_PUBLIC_TAG_SLUGS.filter((slug) => !generatedSlugs.has(slug));
  if (missingPublicPages.length > 0) {
    throw new Error(
      `Generated API docs are missing required public sections: ${missingPublicPages.join(", ")}`
    );
  }

  const pages = await Promise.all(
    families.map(async (family) => ({
      family,
      source: await fs.readFile(path.join(outputDir, `${slugify(family.name)}.mdx`), "utf8"),
    }))
  );

  for (const { family, source } of pages) {
    const sections = source.split(/^## /m).slice(1);
    const anchors = sections.map((section) => /\[#([^\]]+)\]\n/.exec(section)?.[1]);
    const expected = family.operations.map((operation) => operation.operationId);
    if (JSON.stringify(anchors) !== JSON.stringify(expected)) {
      throw new Error(
        `Generated API docs for ${family.name} have sections ${anchors.join(", ")}, expected ${expected.join(", ")}`
      );
    }
    for (const [index, section] of sections.entries()) {
      const missing = SAMPLE_TAB_MARKERS.filter((marker) => !section.includes(marker));
      if (missing.length > 0) {
        throw new Error(`${family.name} ${expected[index]} is missing ${missing.join(", ")}`);
      }
    }
  }
};

const run = async () => {
  const { families } = await loadReference();

  await fs.mkdir(path.dirname(surfacePath), { recursive: true });
  await fs.copyFile(generatedSurfacePath, surfacePath);

  await fs.mkdir(outputDir, { recursive: true });

  const existingFiles = await fs.readdir(outputDir);
  await Promise.all(
    existingFiles
      .filter((fileName) => fileName.endsWith(".mdx") || fileName === "meta.json")
      .map((fileName) => fs.rm(path.join(outputDir, fileName), { force: true }))
  );

  const tagPages = [];
  for (const family of families) {
    const tagSlug = slugify(family.name);
    await fs.writeFile(path.join(outputDir, `${tagSlug}.mdx`), renderFamilyPage(family), "utf8");
    tagPages.push({ title: family.name, slug: tagSlug });
  }
  const exposedOperationsCount = families.reduce(
    (total, family) => total + family.operations.length,
    0
  );

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
      "wallet-operations/index",
      "wallet-operations/balances",
      "---Tutorials---",
      "tutorials/end-to-end-payment-flow",
      "---Integrations---",
      "reference/provider-onboarding",
      "reference/docs-for-ai",
      "reference/postman-collection",
      "---API---",
      ...apiPages,
    ];
  }

  await writeJson(rootMetaPath, {
    title: existingMeta?.title || "Solana Developer Platform Docs",
    pages: newPages,
  });

  await validateGeneratedTagPages({ outputDir, families });

  console.log(
    `Generated ${exposedOperationsCount} endpoints across ${tagPages.length} API sections from ${SOURCE_PATH}`
  );
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
