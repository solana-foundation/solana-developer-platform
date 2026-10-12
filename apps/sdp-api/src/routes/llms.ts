import { DEFAULT_SDP_AI_GUIDE_URL, DEFAULT_SDP_API_URL, DEFAULT_SDP_DOCS_URL } from "@sdp/types";
import { Hono } from "hono";

import { EARN_PUBLIC_SURFACE_PUBLISHED, publicOpenApiTags } from "@/openapi/spec";
import type { Env } from "@/types/env";

const llms = new Hono<{ Bindings: Env }>();

/**
 * Entry path for each tag the public OpenAPI document can publish, keyed by tag
 * name. The family list below comes from the public document's tags, so a held
 * family (Earn, PRO-2038) stays out until it is published; llms.test.ts fails
 * when a publishable tag has no entry here.
 */
export const PUBLIC_FAMILY_ENTRY_PATHS: Readonly<Record<string, string>> = {
  Health: "/health",
  "API Keys": "/v1/api-keys",
  Wallets: "/v1/wallets",
  Projects: "/v1/projects",
  Issuance: "/v1/issuance",
  Payments: "/v1/payments",
  Policies: "/v1/policies",
  Compliance: "/v1/compliance",
  Counterparties: "/v1/counterparties",
  "Asset Profiles": "/v1/issuance/asset-profiles",
  Earn: "/v1/earn",
};

const familyLines = publicOpenApiTags().flatMap(({ name }) => {
  const entryPath = PUBLIC_FAMILY_ENTRY_PATHS[name];
  return entryPath ? [`- ${name}: ${DEFAULT_SDP_API_URL}${entryPath}`] : [];
});

const body = [
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
  "- API keys are issued by SDP and commonly use `sk_test_...` or `sk_live_...` prefixes.",
  ...(EARN_PUBLIC_SURFACE_PUBLISHED
    ? [
        "- Earn strategy reads, previews, withdrawal-route discovery, and instant unsigned external-wallet builds may be anonymous; queued action builds, submits, and tenant reads require an API key.",
      ]
    : []),
  "- Session-only or internal routes are intentionally excluded from this resource.",
  "",
  "## Public endpoint families",
  ...familyLines,
  "",
  "## Versioning",
  "- The OpenAPI document is the source of truth for the current public contract.",
  "- Production releases may lag behind the latest development branch.",
  "",
  "## Scope",
  "- Hidden, internal-only, or session-only route families are intentionally excluded from this resource.",
  "",
].join("\n");

llms.get("/", (c) => {
  c.header("Content-Type", "text/plain; charset=utf-8");
  c.header("Cache-Control", "public, max-age=3600");
  return c.body(body);
});

export default llms;
