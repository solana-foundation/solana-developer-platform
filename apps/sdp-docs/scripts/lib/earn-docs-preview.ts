import { promises as fs } from "node:fs";
import path from "node:path";
import { API_METHODS, apiReferenceSchema } from "@sdp/api-catalog/reference";
import { z } from "zod";
import { isEarnDocsPreview } from "@/lib/earn-docs-preview.mjs";

const documentSchema = z.looseObject({
  paths: z.record(z.string(), z.record(z.string(), z.unknown())),
  components: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  tags: z.array(z.looseObject({ name: z.string() })).optional(),
});
const surfaceSchema = z.looseObject({
  releaseChannel: z.string(),
  modules: z.array(z.string()),
  rampProviders: z.array(z.string()),
  grantableActions: z.array(z.object({ module: z.string(), verbs: z.array(z.string()) })),
});
const previewSchema = z.object({
  partnerOperationIds: z.array(z.string()),
  partner: z.object({
    reference: apiReferenceSchema,
    document: documentSchema,
    grantableActions: z.object({ module: z.literal("earn"), verbs: z.array(z.string()) }),
  }),
});
const metaSchema = z.looseObject({ pages: z.array(z.string()) });
const markerSchema = z.object({
  rootMeta: z.string(),
  embeddedGuide: z.string().nullable(),
  openApiDocument: z.string().nullable(),
});
const MARKER = ".earn-docs-preview.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function refsIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(refsIn);
  if (!isRecord(value)) return [];
  return [
    ...(typeof value.$ref === "string" ? [value.$ref] : []),
    ...Object.values(value).flatMap(refsIn),
  ];
}

/** The partner contract intentionally excludes Treasury and Programs. */
export function isPartnerEarnPath(route: string): boolean {
  return (
    route === "/v1/earn/strategies" ||
    route === "/v1/earn/strategies/{strategyId}" ||
    route === "/v1/earn/vault-deposit-previews" ||
    route.startsWith("/v1/earn/external-wallet/")
  );
}

function validatedPartner(preview: unknown) {
  const { partnerOperationIds, partner } = previewSchema.parse(preview);
  const [family] = partner.reference.families;
  if (family?.name !== "Earn" || partner.reference.families.length !== 1) {
    throw new Error("The branch preview must contain exactly the partner Earn family");
  }
  const expectedIds = new Set(partnerOperationIds);
  const operations = new Map(
    family.operations.map((operation) => [operation.operationId, operation])
  );
  if (
    operations.size === 0 ||
    operations.size !== family.operations.length ||
    operations.size !== expectedIds.size ||
    [...operations.keys()].some((id) => !expectedIds.has(id))
  ) {
    throw new Error("The branch preview differs from the prospective public operation list");
  }
  const seen = new Set<string>();
  for (const [route, item] of Object.entries(partner.document.paths)) {
    if (!isPartnerEarnPath(route)) {
      throw new Error(`Internal Earn path cannot enter a branch preview: ${route}`);
    }
    for (const method of API_METHODS) {
      const value = item[method.toLowerCase()];
      if (value === undefined) continue;
      const operation = z.looseObject({ operationId: z.string() }).parse(value);
      const expected = operations.get(operation.operationId);
      if (!expected || expected.method !== method || expected.path !== route) {
        throw new Error(`Unexpected preview operation: ${method} ${route}`);
      }
      if (seen.has(operation.operationId)) throw new Error("Duplicate preview operation");
      seen.add(operation.operationId);
    }
  }
  if (seen.size !== operations.size) throw new Error("Preview OpenAPI/reference coverage differs");
  return { family, partner };
}

/** Merge only the prospective partner family into this deployment's artifacts. */
export function mergeEarnPreview(
  baseDocument: unknown,
  baseReference: unknown,
  baseSurface: unknown,
  preview: unknown
) {
  const document = documentSchema.parse(baseDocument);
  const reference = apiReferenceSchema.parse(baseReference);
  const surface = surfaceSchema.parse(baseSurface);
  const { family, partner } = validatedPartner(preview);
  if (
    reference.families.some((candidate) => candidate.name === "Earn") ||
    surface.modules.includes("earn") ||
    Object.keys(document.paths).some((route) => route.startsWith("/v1/earn/"))
  ) {
    throw new Error("The branch preview requires normal generation with Earn held");
  }

  // Preserve the channel's existing shared components. Copy only components
  // the added paths reference; never merge another module's preview schemas.
  const components = structuredClone(document.components ?? {});
  const queue = refsIn(partner.document.paths);
  const visited = new Set<string>();
  for (const ref of queue) {
    if (visited.has(ref)) continue;
    visited.add(ref);
    const match = /^#\/components\/([^/]+)\/([^/]+)$/.exec(ref);
    const group = match?.[1];
    const name = match?.[2];
    if (!group || !name) throw new Error(`Unsupported preview component reference: ${ref}`);
    const value = partner.document.components?.[group]?.[name];
    if (value === undefined) throw new Error(`Missing preview component: ${ref}`);
    const current = components[group]?.[name];
    if (current !== undefined && JSON.stringify(current) !== JSON.stringify(value)) {
      throw new Error(`Preview would change a shared channel component: ${ref}`);
    }
    components[group] ??= {};
    components[group][name] = value;
    queue.push(...refsIn(value));
  }
  return {
    document: {
      ...document,
      paths: { ...document.paths, ...partner.document.paths },
      components,
      tags: [...(document.tags ?? []), ...(partner.document.tags ?? [])],
    },
    reference: { families: [...reference.families, family] },
    surface: {
      ...surface,
      earnDocsPreview: true,
      modules: [...surface.modules, "earn"],
      grantableActions: [...surface.grantableActions, partner.grantableActions],
    },
  };
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

/** Remove only files recorded as owned by an earlier preview staging run. */
export async function resetEarnDocsPreview(root: string): Promise<void> {
  const markerPath = path.join(root, MARKER);
  const source = await readOptional(markerPath);
  if (source === null) return;
  const marker = markerSchema.parse(JSON.parse(source));
  await fs.rm(path.join(root, "content/docs/earn"), { recursive: true, force: true });
  const guide = path.join(root, "content/docs/guides/embedded-yield.mdx");
  if (marker.embeddedGuide === null) await fs.rm(guide, { force: true });
  else await fs.writeFile(guide, marker.embeddedGuide, "utf8");
  const openApi = path.join(root, "public/earn/openapi.json");
  if (marker.openApiDocument === null) await fs.rm(openApi, { force: true });
  else await fs.writeFile(openApi, marker.openApiDocument, "utf8");
  await fs.writeFile(path.join(root, "content/docs/meta.json"), marker.rootMeta, "utf8");
  await fs.rm(markerPath);
}

/** Stage partner-only content in the Vercel preview's disposable checkout. */
export async function stageEarnDocsPreview(
  root: string,
  env: Record<string, string | undefined> = process.env
): Promise<void> {
  if (!isEarnDocsPreview(env))
    throw new Error("Earn docs staging is restricted to its branch preview");
  const generated = path.resolve(root, "../sdp-api/generated");
  const readJson = async (name: string) =>
    JSON.parse(await fs.readFile(path.join(generated, name), "utf8")) as unknown;
  const [document, reference, surface, preview] = await Promise.all([
    readJson("openapi.json"),
    readJson("api-reference.json"),
    readJson("public-surface.json"),
    readJson("earn-reference-preview.json"),
  ]);
  const merged = mergeEarnPreview(document, reference, surface, preview);
  const content = path.join(root, "content/docs");
  const unpublished = path.join(root, "content/unpublished");
  const earnDir = path.join(content, "earn");
  try {
    await fs.access(earnDir);
    throw new Error("Refusing to replace an existing published Earn guide directory");
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") throw error;
  }
  const [rootMeta, embeddedGuide, openApiDocument] = await Promise.all([
    fs.readFile(path.join(content, "meta.json"), "utf8"),
    readOptional(path.join(content, "guides/embedded-yield.mdx")),
    readOptional(path.join(root, "public/earn/openapi.json")),
  ]);
  await fs.writeFile(
    path.join(root, MARKER),
    JSON.stringify({ rootMeta, embeddedGuide, openApiDocument }),
    "utf8"
  );
  await fs.mkdir(earnDir, { recursive: true });
  const entries = await fs.readdir(path.join(unpublished, "earn"));
  await Promise.all(
    entries
      .filter((name) => name.endsWith(".mdx") && name !== "treasury.mdx")
      .map(async (name) => {
        const source = await fs.readFile(path.join(unpublished, "earn", name), "utf8");
        if (!/^module: earn$/m.test(source))
          throw new Error(`${name} must keep its Earn module gate`);
        await fs.writeFile(path.join(earnDir, name), source, "utf8");
      })
  );
  const earnMeta = metaSchema.parse(
    JSON.parse(await fs.readFile(path.join(unpublished, "earn/meta.json"), "utf8"))
  );
  await fs.writeFile(
    path.join(earnDir, "meta.json"),
    `${JSON.stringify({ ...earnMeta, pages: earnMeta.pages.filter((page) => page !== "treasury") }, null, 2)}\n`,
    "utf8"
  );
  await fs.mkdir(path.join(content, "guides"), { recursive: true });
  await fs.copyFile(
    path.join(unpublished, "guides/embedded-yield.mdx"),
    path.join(content, "guides/embedded-yield.mdx")
  );
  const meta = metaSchema.parse(JSON.parse(rootMeta));
  if (!meta.pages.includes("earn")) {
    const position = meta.pages.indexOf("---Resources---");
    meta.pages.splice(position < 0 ? meta.pages.length : position, 0, "earn");
  }
  await fs.writeFile(path.join(content, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  await fs.mkdir(path.join(root, "public/earn"), { recursive: true });
  await Promise.all([
    ...(
      [
        ["openapi.json", merged.document],
        ["api-reference.json", merged.reference],
        ["public-surface.json", merged.surface],
      ] as const
    ).map(([name, data]) =>
      fs.writeFile(path.join(generated, name), `${JSON.stringify(data, null, 2)}\n`, "utf8")
    ),
    fs.writeFile(
      path.join(root, "public/earn/openapi.json"),
      `${JSON.stringify(merged.document, null, 2)}\n`,
      "utf8"
    ),
  ]);
}
