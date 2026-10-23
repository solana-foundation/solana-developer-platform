import { Hono } from "hono";
import { unifiedAuthMiddleware } from "@/middleware/auth";
import { meteredQuota } from "@/middleware/metered-quota";
import { projectContextMiddleware } from "@/middleware/project-context";
import { requireAction } from "@/middleware/require-action";
import { validateBody, validateParams } from "@/middleware/validate";
import type { Env } from "@/types/env";
import { getTokenTerms, quoteTokenAmount } from "./handlers";
import { quoteTokenAmountSchema, tokenMintParamsSchema } from "./schemas";

/**
 * Each request reads the chain once (the mint and the Clock); the quota
 * bounds how much RPC one credential can drive, as on the other chain reads.
 */
export const TOKEN_TERMS_QUOTA = { name: "token-terms", actorMax: 60, orgMax: 240 };

/**
 * Token Terms and movement quotes (ADR 0012), read-only: a Payments read,
 * under the caller's project, with the action every transfer read takes.
 */
export const tokens = new Hono<{ Bindings: Env }>();

tokens.use("*", unifiedAuthMiddleware());
tokens.use("*", projectContextMiddleware());
tokens.get(
  "/:mint/terms",
  requireAction("transfers.read"),
  validateParams(tokenMintParamsSchema),
  meteredQuota(TOKEN_TERMS_QUOTA),
  getTokenTerms
);
// A POST because it takes a body; it moves and stores nothing, so it takes no
// Idempotency-Key (idempotency-route-inventory.test.ts pins the exemption).
tokens.post(
  "/:mint/quote",
  requireAction("transfers.read"),
  validateParams(tokenMintParamsSchema),
  validateBody(quoteTokenAmountSchema),
  meteredQuota(TOKEN_TERMS_QUOTA),
  quoteTokenAmount
);
