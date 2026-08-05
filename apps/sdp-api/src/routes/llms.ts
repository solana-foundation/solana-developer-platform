import { DEFAULT_SDP_AI_GUIDE_URL, DEFAULT_SDP_API_URL, DEFAULT_SDP_DOCS_URL } from "@sdp/types";
import { Hono } from "hono";

import type { Env } from "@/types/env";

const llms = new Hono<{ Bindings: Env }>();

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
  "- Session-only or internal routes are intentionally excluded from this resource.",
  "",
  "## Public endpoint families",
  `- Health: ${DEFAULT_SDP_API_URL}/health`,
  `- API keys: ${DEFAULT_SDP_API_URL}/v1/api-keys`,
  `- Wallets and custody: ${DEFAULT_SDP_API_URL}/v1/wallets`,
  `- Projects: ${DEFAULT_SDP_API_URL}/v1/projects`,
  `- Issuance: ${DEFAULT_SDP_API_URL}/v1/issuance`,
  `- Payments: ${DEFAULT_SDP_API_URL}/v1/payments`,
  `- Compliance: ${DEFAULT_SDP_API_URL}/v1/compliance`,
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
