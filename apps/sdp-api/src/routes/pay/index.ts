import { Hono } from "hono";
import { publicRoute } from "@/middleware/require-action";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import { paymentRequestScope } from "./context";
import { createSponsoredTransaction, getPaymentRequest, getTransactionMetadata } from "./handlers";
import { transactionRequestBodySchema } from "./schemas";

export const pay = new Hono<{ Bindings: Env }>();

pay.get(
  "/:token",
  publicRoute("payment link: the link's public token is the credential"),
  paymentRequestScope,
  getPaymentRequest
);
pay.get(
  "/:token/tx",
  publicRoute("payment link: the link's public token is the credential"),
  getTransactionMetadata
);
pay.post(
  "/:token/tx",
  publicRoute("payment link: the link's public token is the credential"),
  validateBody(transactionRequestBodySchema),
  paymentRequestScope,
  createSponsoredTransaction
);
