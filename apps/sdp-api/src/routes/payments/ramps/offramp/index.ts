import { Hono } from "hono";
import { requirePermissions } from "@/middleware/auth";
import { meteredQuota } from "@/middleware/metered-quota";
import { policyGate } from "@/middleware/policy-gate";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import {
  createOfframpQuote,
  estimateOfframp,
  extractOfframpQuotePolicyCandidate,
  listOfframpCurrencies,
} from "./handlers";
import { createOfframpQuoteSchema, estimateOfframpSchema } from "./schemas";

const offramp = new Hono<{ Bindings: Env }>();

offramp.get("/currency", requirePermissions("payments:read"), listOfframpCurrencies);
// Estimates fan out one live call per provider on the corridor and quotes
// create provider-side records, so both carry fail-closed metered quotas.
offramp.post(
  "/estimate",
  requirePermissions("payments:read"),
  validateBody(estimateOfframpSchema),
  meteredQuota({ name: "ramp-estimate", actorMax: 30, orgMax: 120 }),
  estimateOfframp
);
offramp.post(
  "/quote",
  requirePermissions("payments:write", "wallets:read"),
  validateBody(createOfframpQuoteSchema),
  meteredQuota({ name: "ramp-quote", actorMax: 20, orgMax: 60 }),
  policyGate({ extract: extractOfframpQuotePolicyCandidate }),
  createOfframpQuote
);

export default offramp;
