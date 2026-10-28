import { Hono } from "hono";
import { authorize } from "@/middleware/authorize";
import { idempotent } from "@/middleware/idempotency";
import { requireAction } from "@/middleware/require-action";
import { validateBody, validateParams } from "@/middleware/validate";
import { authorizeExistingPaymentRequest, authorizePaymentRequest } from "@/routes/payments/access";
import { canonicalizePaymentBody } from "@/routes/payments/fingerprint";
import type { Env } from "@/types/env";
import {
  cancelPaymentRequest,
  createPaymentRequest,
  getPaymentRequest,
  getPaymentRequestLink,
  listPaymentRequests,
} from "./handlers";
import { createPaymentRequestSchema, paymentRequestParamsSchema } from "./schemas";

export const paymentRequests = new Hono<{ Bindings: Env }>();

paymentRequests.get("/", requireAction("payment_requests.read"), listPaymentRequests);
paymentRequests.get(
  "/:paymentRequestId",
  requireAction("payment_requests.read"),
  getPaymentRequest
);
paymentRequests.get(
  "/:paymentRequestId/link",
  requireAction("payment_requests.manage"),
  getPaymentRequestLink
);
paymentRequests.post(
  "/",
  requireAction("payment_requests.manage"),
  validateBody(createPaymentRequestSchema),
  authorize(authorizePaymentRequest),
  idempotent({ key: "accepted", serverErrors: "store", canonicalize: canonicalizePaymentBody }),
  createPaymentRequest
);
paymentRequests.post(
  "/:paymentRequestId/cancel",
  requireAction("payment_requests.manage"),
  validateParams(paymentRequestParamsSchema),
  authorize(authorizeExistingPaymentRequest),
  idempotent({ key: "accepted", serverErrors: "store" }),
  cancelPaymentRequest
);
