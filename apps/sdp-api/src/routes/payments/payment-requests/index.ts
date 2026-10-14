import { Hono } from "hono";
import { requireAction } from "@/middleware/require-action";
import { authorize } from "@/middleware/authorize";
import { idempotent } from "@/middleware/idempotency";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import { authorizePaymentRequest } from "../access";
import { createPaymentRequest, listPaymentRequests } from "./handlers";
import { createPaymentRequestSchema } from "./schemas";

const paymentRequests = new Hono<{ Bindings: Env }>();

paymentRequests.get("/", requireAction("payment_requests.read"), listPaymentRequests);
paymentRequests.post(
  "/",
  requireAction("payment_requests.manage"),
  validateBody(createPaymentRequestSchema),
  authorize(authorizePaymentRequest),
  idempotent({ key: "accepted", serverErrors: "store" }),
  createPaymentRequest
);

export default paymentRequests;
