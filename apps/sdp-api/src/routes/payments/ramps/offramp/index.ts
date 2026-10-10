import { Hono } from "hono";
import { requireAllowedOperation } from "@/middleware/allowed-operations";
import { requirePermissions } from "@/middleware/auth";
import { meteredQuota } from "@/middleware/metered-quota";
import { requestGate } from "@/middleware/request-gate";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import {
  createOfframpQuote,
  estimateOfframp,
  extractOfframpQuoteRequest,
  listOfframpCurrencies,
} from "./handlers";
import { createOfframpQuoteSchema, estimateOfframpSchema } from "./schemas";

const offramp = new Hono<{ Bindings: Env }>();

offramp.get("/currency", requirePermissions("payments:read"), listOfframpCurrencies);
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
  requireAllowedOperation("ramp_offramp_quote"),
  validateBody(createOfframpQuoteSchema),
  meteredQuota({ name: "ramp-quote", actorMax: 20, orgMax: 60 }),
  requestGate({ extract: extractOfframpQuoteRequest }),
  createOfframpQuote
);

export default offramp;
