import { Hono } from "hono";
import { requireAllowedOperation } from "@/middleware/allowed-operations";
import { requirePermissions } from "@/middleware/auth";
import { meteredQuota } from "@/middleware/metered-quota";
import { requestGate } from "@/middleware/request-gate";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import {
  createOnrampQuote,
  estimateOnramp,
  extractOnrampQuoteRequest,
  listOnrampCurrencies,
} from "./handlers";
import { createOnrampQuoteSchema, estimateOnrampSchema } from "./schemas";

export const onramp = new Hono<{ Bindings: Env }>();

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
  requirePermissions("payments:write", "wallets:read", "counterparties:read"),
  requireAllowedOperation("ramp_onramp_quote"),
  validateBody(createOnrampQuoteSchema),
  meteredQuota({ name: "ramp-quote", actorMax: 20, orgMax: 60 }),
  requestGate({ extract: extractOnrampQuoteRequest }),
  createOnrampQuote
);
