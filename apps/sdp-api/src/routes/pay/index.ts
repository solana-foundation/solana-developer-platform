import { Hono } from "hono";
import { publicRoute } from "@/middleware/require-action";
import type { Env } from "@/types/env";
import { paymentRequestScope } from "./context";
import { getPaymentRequest } from "./handlers";

export const pay = new Hono<{ Bindings: Env }>();

pay.get(
  "/:token",
  publicRoute("payment link: the link's public token is the credential"),
  paymentRequestScope,
  getPaymentRequest
);
