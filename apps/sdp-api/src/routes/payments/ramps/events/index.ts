import { Hono } from "hono";
import { requirePermissions } from "@/middleware/auth";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import { recordCoinbaseRampEvent, recordMoneygramRampEvent } from "./handlers";
import { coinbaseRampEventSchema, moneygramRampEventSchema } from "./schemas";

const events = new Hono<{ Bindings: Env }>();

events.post(
  "/moneygram/events",
  requirePermissions("payments:write"),
  validateBody(moneygramRampEventSchema),
  recordMoneygramRampEvent
);
events.post(
  "/coinbase/events",
  requirePermissions("payments:write"),
  validateBody(coinbaseRampEventSchema),
  recordCoinbaseRampEvent
);

export default events;
