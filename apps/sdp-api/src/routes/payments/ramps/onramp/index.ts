import { Hono } from "hono";
import { meteredQuota } from "@/middleware/metered-quota";
import { requestGate } from "@/middleware/request-gate";
import { requireAction } from "@/middleware/require-action";
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

onramp.get("/currency", requireAction("onramp.read"), listOnrampCurrencies);
onramp.post(
  "/estimate",
  requireAction("onramp.read"),
  validateBody(estimateOnrampSchema),
  meteredQuota({ name: "ramp-estimate", actorMax: 30, orgMax: 120 }),
  estimateOnramp
);
onramp.post(
  "/quote",
  requireAction("onramp.execute"),
  validateBody(createOnrampQuoteSchema),
  meteredQuota({ name: "ramp-quote", actorMax: 20, orgMax: 60 }),
  requestGate({ extract: extractOnrampQuoteRequest }),
  createOnrampQuote
);
