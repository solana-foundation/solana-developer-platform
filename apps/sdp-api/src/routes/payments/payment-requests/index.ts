import { Hono } from "hono";
import { requirePermissions } from "@/middleware/auth";
import { idempotent } from "@/middleware/idempotency";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import { createPaymentRequest, listPaymentRequests } from "./handlers";
import { createPaymentRequestSchema } from "./schemas";

const paymentRequests = new Hono<{ Bindings: Env }>();

paymentRequests.get("/", requirePermissions("payments:read"), listPaymentRequests);
paymentRequests.post(
  "/",
  requirePermissions("payments:write", "wallets:read"),
  idempotent({ key: "accepted" }),
  validateBody(createPaymentRequestSchema),
  createPaymentRequest
);

export default paymentRequests;
