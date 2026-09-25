import { Hono } from "hono";
import { requirePermissions } from "@/middleware/auth";
import { meteredQuota } from "@/middleware/metered-quota";
import { policyGate } from "@/middleware/policy-gate";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import { findRampQuoteIdempotentKeyReplay } from "../quote-idempotency";
import {
  createOnrampQuote,
  estimateOnramp,
  extractOnrampQuotePolicyCandidate,
  listOnrampCurrencies,
} from "./handlers";
import { createOnrampQuoteSchema, estimateOnrampSchema } from "./schemas";

const onramp = new Hono<{ Bindings: Env }>();

onramp.get("/currency", requirePermissions("payments:read"), listOnrampCurrencies);
onramp.post(
  "/estimate",
  requirePermissions("payments:read"),
  validateBody(estimateOnrampSchema),
  meteredQuota({ name: "ramp-estimate", actorMax: 30, orgMax: 120 }),
  estimateOnramp
);
onramp.post(
  "/quote",
  requirePermissions("payments:write", "wallets:read"),
  validateBody(createOnrampQuoteSchema),
  meteredQuota({ name: "ramp-quote", actorMax: 20, orgMax: 60 }),
  policyGate({
    extract: extractOnrampQuotePolicyCandidate,
    findIdempotentKeyReplay: findRampQuoteIdempotentKeyReplay,
  }),
  createOnrampQuote
);

export default onramp;
