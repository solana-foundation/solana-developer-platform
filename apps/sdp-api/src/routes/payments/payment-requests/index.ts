import { Hono } from "hono";
import { requirePermissions } from "@/middleware/auth";
import { authorize } from "@/middleware/authorize";
import { idempotent } from "@/middleware/idempotency";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import { authorizePaymentRequest } from "../access";
import { createPaymentRequest, listPaymentRequests } from "./handlers";
import { createPaymentRequestSchema } from "./schemas";

export const paymentRequests = new Hono<{ Bindings: Env }>();

paymentRequests.get("/", requirePermissions("payments:read"), listPaymentRequests);
paymentRequests.post(
  "/",
  requirePermissions("payments:write", "wallets:read"),
  validateBody(createPaymentRequestSchema),
  authorize(authorizePaymentRequest),
  idempotent({ key: "accepted", serverErrors: "store" }),
  createPaymentRequest
);
