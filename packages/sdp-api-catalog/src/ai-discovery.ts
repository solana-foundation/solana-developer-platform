import {
  DEFAULT_SDP_AI_GUIDE_URL,
  DEFAULT_SDP_AI_LLMS_FULL_URL,
  DEFAULT_SDP_AI_LLMS_URL,
  DEFAULT_SDP_API_URL,
  DEFAULT_SDP_DOCS_URL,
  getSdpDocsOrigin,
} from "@sdp/types/site";
import { z } from "zod";

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

type TaggedOperation = { tags?: string[] };
type DiscoveryPath = Partial<Record<(typeof HTTP_METHODS)[number], TaggedOperation>>;

/** The part of a public OpenAPI document needed by both llms.txt outputs. */
export type AiDiscoveryDocument = {
  paths: Readonly<Record<string, DiscoveryPath | undefined>>;
  tags?: readonly { name: string }[];
};

const taggedOperationSchema = z.object({ tags: z.array(z.string()).optional() });
const discoveryPathSchema = z.object({
  get: taggedOperationSchema.optional(),
  post: taggedOperationSchema.optional(),
  put: taggedOperationSchema.optional(),
  patch: taggedOperationSchema.optional(),
  delete: taggedOperationSchema.optional(),
});

/** Parse the generated OpenAPI JSON at the docs build boundary. */
export const aiDiscoveryDocumentSchema = z.object({
  paths: z.record(z.string(), discoveryPathSchema),
  tags: z.array(z.object({ name: z.string() })),
});

export type AiDiscoveryFamily = { name: string; prefix: string };

/** Published tags, in OpenAPI order, with each family's most common path prefix. */
export function apiDiscoveryFamilies(document: AiDiscoveryDocument): AiDiscoveryFamily[] {
  if (document.tags === undefined) {
    throw new Error("Public OpenAPI document has no tags");
  }

  const prefixCounts = new Map<string, Map<string, number>>();
  for (const [path, item] of Object.entries(document.paths)) {
    if (item === undefined) {
      throw new Error(`Public OpenAPI path ${path} is missing`);
    }
    const prefix = `/${path
      .split("/")
      .filter(Boolean)
      .slice(0, path.startsWith("/v1/") ? 2 : 1)
      .join("/")}`;
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (operation === undefined) continue;
      const tag = operation.tags?.[0];
      if (tag === undefined) {
        throw new Error(`${method.toUpperCase()} ${path} has no API family tag`);
      }
      const counts = prefixCounts.get(tag) ?? new Map<string, number>();
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
      prefixCounts.set(tag, counts);
    }
  }

  const declaredTags = new Set(document.tags.map((tag) => tag.name));
  for (const name of prefixCounts.keys()) {
    if (!declaredTags.has(name)) {
      throw new Error(`Public OpenAPI family ${name} has no tag declaration`);
    }
  }

  return document.tags.flatMap(({ name }) => {
    const counts = prefixCounts.get(name);
    if (counts === undefined) return [];
    const mostCommon = [...counts].sort((left, right) => right[1] - left[1])[0];
    if (mostCommon === undefined) {
      throw new Error(`Public OpenAPI family ${name} has no path`);
    }
    return [{ name, prefix: mostCommon[0] }];
  });
}

type DocsPageLink = { title: string; description: string; url: string };

type LlmsInput =
  | { audience: "api"; document: AiDiscoveryDocument }
  | {
      audience: "docs";
      document: AiDiscoveryDocument;
      supportedSurfaces: readonly string[];
      startHere: readonly DocsPageLink[];
    };

const API_REFERENCE_URL = `${DEFAULT_SDP_DOCS_URL}/reference/api`;
const OPENAPI_URL = `${DEFAULT_SDP_API_URL}/openapi.json`;
const DOCS_ORIGIN = getSdpDocsOrigin(DEFAULT_SDP_DOCS_URL);

function familyLines(families: readonly AiDiscoveryFamily[]): string[] {
  return families.map((family) => `- ${family.name}: ${DEFAULT_SDP_API_URL}${family.prefix}`);
}

function renderApiLlms(families: readonly AiDiscoveryFamily[]): string {
  const earnPublished = families.some((family) => family.prefix === "/v1/earn");
  return [
    "# Solana Developer Platform API",
    "",
    "> Public machine-readable discovery entry point for the SDP API.",
    "",
    "## Canonical URLs",
    `- API base URL: ${DEFAULT_SDP_API_URL}`,
    `- OpenAPI: ${OPENAPI_URL}`,
    `- API reference: ${API_REFERENCE_URL}`,
    `- Product docs: ${DEFAULT_SDP_DOCS_URL}`,
    `- AI guide: ${DEFAULT_SDP_AI_GUIDE_URL}`,
    "",
    "## Authentication",
    "- Use `Authorization: Bearer <api_key>`.",
    "- API keys are issued by SDP in the shared `sf_<key id>_<secret><checksum>` format; keys issued earlier (`sk_test_...`, `sk_live_...`) are still accepted.",
    ...(earnPublished
      ? [
          "- Earn strategy reads, previews, withdrawal-route discovery, and instant unsigned external-wallet builds may be anonymous; queued action builds, submits, and tenant reads require an API key.",
        ]
      : []),
    "- Session-only or internal routes are intentionally excluded from this resource.",
    "",
    "## Public endpoint families",
    ...familyLines(families),
    "",
    "## Versioning",
    "- The OpenAPI document is the source of truth for the current public contract.",
    "- Production releases may lag behind the latest development branch.",
    "",
    "## Scope",
    "- Hidden, internal-only, or session-only route families are intentionally excluded from this resource.",
    "- Only the modules this deployment's release channel runs are listed.",
    "",
  ].join("\n");
}

function renderDocsLlms(
  families: readonly AiDiscoveryFamily[],
  supportedSurfaces: readonly string[],
  startHere: readonly DocsPageLink[]
): string {
  return [
    "# Solana Developer Platform",
    "",
    "> Public documentation and API discovery resources for Solana Developer Platform.",
    "",
    "## Canonical URLs",
    `- Docs: ${DEFAULT_SDP_DOCS_URL}`,
    `- API: ${DEFAULT_SDP_API_URL}`,
    `- API reference: ${API_REFERENCE_URL}`,
    `- OpenAPI: ${OPENAPI_URL}`,
    `- AI guide: ${DEFAULT_SDP_AI_GUIDE_URL}`,
    "",
    "## Supported surfaces",
    ...supportedSurfaces.map((surface) => `- ${surface}`),
    "",
    "## Public endpoint families",
    ...familyLines(families),
    "",
    "## Start here",
    ...startHere.map((page) => {
      const description = page.description
        ? `: ${page.description.replace(/\s+/g, " ").trim()}`
        : "";
      return `- [${page.title}](${page.url})${description}`;
    }),
    "",
    "## AI guide",
    `- [Docs for AI](${DEFAULT_SDP_AI_GUIDE_URL}): Human-readable landing page for machine-readable SDP docs resources, usage guidance, and public AI scope.`,
    "",
    "## Machine-readable resources",
    `- [llms.txt](${DEFAULT_SDP_AI_LLMS_URL})`,
    `- [llms-full.txt](${DEFAULT_SDP_AI_LLMS_FULL_URL})`,
    `- [SKILL.md](${DOCS_ORIGIN}/SKILL.md): Agent skill with the rules for building on SDP.`,
    "- Any docs page as Markdown: add `.md` to its URL.",
    `- [OpenAPI](${OPENAPI_URL})`,
    "",
    "## Scope",
    "- Public AI artifacts intentionally exclude hidden or internal-only API families.",
    "",
  ].join("\n");
}

/** The one generator for docs and API llms.txt, using the same public family list. */
export function renderLlmsTxt(input: LlmsInput): string {
  const families = apiDiscoveryFamilies(input.document);
  if (input.audience === "api") {
    return renderApiLlms(families);
  }
  return renderDocsLlms(families, input.supportedSurfaces, input.startHere);
}
