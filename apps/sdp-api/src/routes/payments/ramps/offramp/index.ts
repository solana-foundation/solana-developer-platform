import { Hono } from "hono";
import { meteredQuota } from "@/middleware/metered-quota";
import { requestGate } from "@/middleware/request-gate";
import { requireAction } from "@/middleware/require-action";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import {
  createOfframpQuote,
  estimateOfframp,
  extractOfframpQuoteRequest,
  listOfframpCurrencies,
} from "./handlers";
import { createOfframpQuoteSchema, estimateOfframpSchema } from "./schemas";

export const offramp = new Hono<{ Bindings: Env }>();

offramp.get("/currency", requireAction("offramp.read"), listOfframpCurrencies);
offramp.post(
  "/estimate",
  requireAction("offramp.read"),
  validateBody(estimateOfframpSchema),
  meteredQuota({ name: "ramp-estimate", actorMax: 30, orgMax: 120 }),
  estimateOfframp
);
offramp.post(
  "/quote",
  requireAction("offramp.execute"),
  validateBody(createOfframpQuoteSchema),
  meteredQuota({ name: "ramp-quote", actorMax: 20, orgMax: 60 }),
  requestGate({ extract: extractOfframpQuoteRequest }),
  createOfframpQuote
);
