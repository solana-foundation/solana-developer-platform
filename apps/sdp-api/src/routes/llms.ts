import { resolveSdpReleaseChannel, type SdpReleaseChannel } from "@sdp/types/release-channels";
import {
  DEFAULT_SDP_AI_GUIDE_URL,
  DEFAULT_SDP_API_URL,
  DEFAULT_SDP_DOCS_URL,
} from "@sdp/types/site";
import { Hono } from "hono";
import type { OpenAPIObject } from "openapi3-ts/oas30";
import { publicRoute } from "@/middleware/require-action";
import { createPublicOpenApiDocument } from "@/openapi/spec";
import type { Env } from "@/types/env";

export const llms = new Hono<{ Bindings: Env }>();

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

/**
 * Each published tag with the path prefix most of its operations share, so the
 * family list is exactly the families the channel's OpenAPI document carries.
 */
function endpointFamilies(document: OpenAPIObject): { name: string; prefix: string }[] {
  const prefixCounts = new Map<string, Map<string, number>>();
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    const prefix = `/${path
      .split("/")
      .filter(Boolean)
      .slice(0, path.startsWith("/v1/") ? 2 : 1)
      .join("/")}`;
    for (const method of HTTP_METHODS) {
      const tag = item?.[method]?.tags?.[0];
      if (!tag) continue;
      const counts = prefixCounts.get(tag) ?? new Map<string, number>();
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
      prefixCounts.set(tag, counts);
    }
  }
  return (document.tags ?? []).flatMap(({ name }) => {
    const counts = prefixCounts.get(name);
    if (!counts) return [];
    const [prefix] = [...counts].sort((left, right) => right[1] - left[1])[0] ?? [];
    return prefix ? [{ name, prefix }] : [];
  });
}

function renderBody(releaseChannel: SdpReleaseChannel): string {
  const document = createPublicOpenApiDocument({ releaseChannel });
  const families = endpointFamilies(document);
  const earnPublished = families.some((family) => family.prefix === "/v1/earn");
  return [
    "# Solana Developer Platform API",
    "",
    "> Public machine-readable discovery entry point for the SDP API.",
    "",
    "## Canonical URLs",
    `- API base URL: ${DEFAULT_SDP_API_URL}`,
    `- OpenAPI: ${DEFAULT_SDP_API_URL}/openapi.json`,
    `- Interactive API docs: ${DEFAULT_SDP_API_URL}/docs`,
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
    ...families.map((family) => `- ${family.name}: ${DEFAULT_SDP_API_URL}${family.prefix}`),
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

/** One body per release channel, built on first request from that channel's document. */
const bodies = new Map<SdpReleaseChannel, string>();

llms.get("/", publicRoute("AI discovery resource"), (c) => {
  const releaseChannel = resolveSdpReleaseChannel(c.env.SDP_RELEASE_CHANNEL);
  let body = bodies.get(releaseChannel);
  if (body === undefined) {
    body = renderBody(releaseChannel);
    bodies.set(releaseChannel, body);
  }
  c.header("Content-Type", "text/plain; charset=utf-8");
  c.header("Cache-Control", "public, max-age=3600");
  return c.body(body);
});
