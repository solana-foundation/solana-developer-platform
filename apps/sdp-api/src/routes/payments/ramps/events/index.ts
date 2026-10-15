import { Hono } from "hono";
import { requirePermissions } from "@/middleware/auth";
import { requireRampProvider } from "@/middleware/require-module";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import { recordCoinbaseRampEvent } from "./handlers";
import { coinbaseRampEventSchema } from "./schemas";

const events = new Hono<{ Bindings: Env }>();

events.post(
  "/coinbase/events",
  requireRampProvider("coinbase"),
  requirePermissions("payments:write"),
  validateBody(coinbaseRampEventSchema),
  recordCoinbaseRampEvent
);

export default events;
