import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apiReferenceSchema } from "@sdp/api-catalog/reference";
import {
  operationGroups,
  renderFamilyIndex,
  renderOperationPage,
  SAMPLE_TAB_MARKERS,
} from "./lib/api-reference-page.ts";
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

<ActionLinks>
  <a href="${POSTMAN_COLLECTION_ROUTE}" download>Download Postman collection</a>
  <a href="${POSTMAN_COLLECTION_ROUTE}">Open raw JSON</a>
</ActionLinks>

Every operation follows the [API conventions](/docs/reference/conventions): authentication, environments, idempotency, errors, pagination, rate limits and versioning.

${links}
`;
};

const writeJson = async (filePath, value) => {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

// Families every release channel runs, so every build must render them.
const ALWAYS_PUBLIC_TAG_SLUGS = ["health", "wallets", "projects"];

/** An operation's page, beside its family's table: `/docs/reference/api/<family>/<endpointId>`. */
const operationHref = (familySlug, operation) =>
  `/docs/reference/api/${familySlug}/${operation.endpointId}`;

/**
 * Where a family's operation pages sit in its folder: each group's in a `(group)` folder, which
 * Fumadocs shows in the sidebar but leaves out of the pages' URLs, or all of them in the
 * family's folder when it has no groups.
 */
const familyLayout = (family) => {
  const groups = operationGroups(family).map((group) => {
    if (group.title === null) return { ...group, folder: "" };
    const slug = slugify(group.title);
    if (slug === "") throw new Error(`${family.name}'s group "${group.title}" has no slug`);
    return { ...group, folder: `(${slug})` };
  });
  const folders = groups.map((group) => group.folder);
  if (new Set(folders).size !== folders.length) {
    throw new Error(`${family.name} has two groups in one folder: ${folders.join(", ")}`);
  }
  return groups;
};

/**
 * Every family's table links each of its operations, and every operation has its page with the
 * three request samples: the reference's coverage, checked on what was written.
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
    families.flatMap((family) => {
      const slug = slugify(family.name);
      return [
        fs.readFile(path.join(outputDir, slug, "index.mdx"), "utf8").then((source) => ({
          family,
          slug,
          table: source,
        })),
        ...familyLayout(family).flatMap((group) =>
          group.operations.map((operation) =>
            fs
              .readFile(
                path.join(outputDir, slug, group.folder, `${operation.endpointId}.mdx`),
                "utf8"
              )
              .then((source) => ({ family, operation, source }))
          )
        ),
      ];
    })
  );

  for (const page of pages) {
    if ("table" in page) {
      const unlinked = page.family.operations.filter(
        (operation) => !page.table.includes(`](${operationHref(page.slug, operation)})`)
      );
      if (unlinked.length > 0) {
        throw new Error(
          `The ${page.family.name} table does not link ${unlinked.map((operation) => operation.operationId).join(", ")}`
        );
      }
      continue;
    }
    const missing = SAMPLE_TAB_MARKERS.filter((marker) => !page.source.includes(marker));
    if (missing.length > 0) {
      throw new Error(`${page.operation.operationId}'s page is missing ${missing.join(", ")}`);
    }
  }
};

const run = async () => {
  const { families } = await loadReference();

  await fs.mkdir(path.dirname(surfacePath), { recursive: true });
  await fs.copyFile(generatedSurfacePath, surfacePath);

  await fs.mkdir(outputDir, { recursive: true });

  // What an earlier run wrote: the index, the meta and a folder per family.
  const existingEntries = await fs.readdir(outputDir, { withFileTypes: true });
  await Promise.all(
    existingEntries
      .filter(
        (entry) => entry.isDirectory() || entry.name.endsWith(".mdx") || entry.name === "meta.json"
      )
      .map((entry) => fs.rm(path.join(outputDir, entry.name), { recursive: true, force: true }))
  );

  const tagPages = families.map((family) => ({ title: family.name, slug: slugify(family.name) }));
  const index = tagPages.find((tagPage) => tagPage.slug === "index");
  if (index !== undefined) {
    throw new Error(`The ${index.title} family's folder would replace the API reference index`);
  }
  // A folder per family: its table as the folder's index, then a page per operation, in its
  // group's folder when the family has groups. Each meta.json lists its pages (or the family's
  // its groups) in document order for the sidebar and the previous and next links.
  await Promise.all(
    families.map(async (family, position) => {
      const { slug } = tagPages[position];
      const familyDir = path.join(outputDir, slug);
      const groups = familyLayout(family);
      await Promise.all(
        groups.map((group) => fs.mkdir(path.join(familyDir, group.folder), { recursive: true }))
      );
      const endpointIds = (group) => group.operations.map((operation) => operation.endpointId);
      await Promise.all([
        fs.writeFile(
          path.join(familyDir, "index.mdx"),
          renderFamilyIndex(family, (operation) => operationHref(slug, operation)),
          "utf8"
        ),
        writeJson(path.join(familyDir, "meta.json"), {
          title: family.name,
          pages: groups.flatMap((group) =>
            group.title === null ? endpointIds(group) : [group.folder]
          ),
        }),
        ...groups.flatMap((group) => [
          ...(group.title === null
            ? []
            : [
                writeJson(path.join(familyDir, group.folder, "meta.json"), {
                  title: group.title,
                  pages: endpointIds(group),
                }),
              ]),
          ...group.operations.map((operation) =>
            fs.writeFile(
              path.join(familyDir, group.folder, `${operation.endpointId}.mdx`),
              renderOperationPage(operation),
              "utf8"
            )
          ),
        ]),
      ]);
    })
  );
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
