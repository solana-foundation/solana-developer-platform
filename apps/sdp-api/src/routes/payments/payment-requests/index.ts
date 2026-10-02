import { Hono } from "hono";
import { requirePermissions } from "@/middleware/auth";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import { createPaymentRequest, getPaymentRequest, listPaymentRequests } from "./handlers";
import { createPaymentRequestSchema } from "./schemas";

const paymentRequests = new Hono<{ Bindings: Env }>();

paymentRequests.get("/", requirePermissions("payments:read"), listPaymentRequests);
paymentRequests.get("/:requestId", requirePermissions("payments:read"), getPaymentRequest);
paymentRequests.post(
  "/",
  requirePermissions("payments:write", "wallets:read"),
  validateBody(createPaymentRequestSchema),
  createPaymentRequest
);

export default paymentRequests;
