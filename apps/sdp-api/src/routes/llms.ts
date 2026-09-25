import { DEFAULT_SDP_AI_GUIDE_URL, DEFAULT_SDP_API_URL, DEFAULT_SDP_DOCS_URL } from "@sdp/types";
import { Hono } from "hono";
import type { OpenAPIObject } from "openapi3-ts/oas30";

import { createPublicOpenApiDocument } from "@/openapi/spec";
import type { Env } from "@/types/env";

const llms = new Hono<{ Bindings: Env }>();

/**
 * Curated presentation for each tag in the public OpenAPI document. The
 * inventory itself comes from the document (see buildLlmsBody), so a family
 * the publication gate holds back cannot be re-introduced here; this table
 * only labels the families and points at a representative public URL.
 * llms.test.ts fails when a public tag has no entry, so the table cannot
 * silently lag the public contract.
 */
const FAMILY_PRESENTATION: Record<string, { label: string; path: string }> = {
  Health: { label: "Health", path: "/health" },
  "API Keys": { label: "API keys", path: "/v1/api-keys" },
  Wallets: { label: "Wallets and custody", path: "/v1/wallets" },
  Projects: { label: "Projects", path: "/v1/projects" },
  Issuance: { label: "Issuance", path: "/v1/issuance" },
  Payments: { label: "Payments", path: "/v1/payments" },
  Policies: { label: "Policies", path: "/v1/policies" },
  Compliance: { label: "Compliance", path: "/v1/compliance" },
  Counterparties: { label: "Counterparties", path: "/v1/counterparties" },
  "Asset Profiles": { label: "Asset profiles", path: "/v1/issuance/asset-profiles" },
  Earn: { label: "Earn", path: "/v1/earn" },
};

/**
 * Only surfaced when the public document actually publishes Earn (the
 * EARN_PUBLIC_SURFACE_PUBLISHED gate). Describes the intentional optional-auth
 * runtime tier; it is not a permission change and never widens what the
 * routes accept.
 */
const EARN_ANONYMOUS_TIER_LINE =
  "- Earn strategy reads, previews, withdrawal-route discovery, and instant unsigned external-wallet builds may be anonymous; queued action builds, submits, and tenant reads require an API key.";

/**
 * Builds the /llms.txt discovery body from the same gated public OpenAPI
 * document that backs /openapi.json, so the advertised endpoint inventory and
 * the authentication wording derive from one publication configuration
 * instead of a second, drift-prone list (SOLA9-47 / APE-710).
 */
export function buildLlmsBody(publicDocument: OpenAPIObject): string {
  const tags = (publicDocument.tags ?? []).map((tag) => tag.name);
  const publishEarn = tags.includes("Earn");

  const familyLines = tags
    .map((tag) => FAMILY_PRESENTATION[tag])
    .filter((family) => family !== undefined)
    .map((family) => `- ${family.label}: ${DEFAULT_SDP_API_URL}${family.path}`);

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
    "- API keys are issued by SDP and commonly use `sk_test_...` or `sk_live_...` prefixes.",
    ...(publishEarn ? [EARN_ANONYMOUS_TIER_LINE] : []),
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
}

// Same build-time derivation as routes/openapi.ts: EARN_PUBLIC_SURFACE_
// PUBLISHED is a module constant, not a runtime flag, so evaluating the body
// once at startup keeps the previous caching behavior without weakening the
// gate.
const body = buildLlmsBody(createPublicOpenApiDocument());

llms.get("/", (c) => {
  c.header("Content-Type", "text/plain; charset=utf-8");
  c.header("Cache-Control", "public, max-age=3600");
  return c.body(body);
});

export default llms;
