import { Hono } from "hono";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import { createSponsoredTransaction, getPaymentRequest, getTransactionMetadata } from "./handlers";
import { transactionRequestBodySchema } from "./schemas";

const pay = new Hono<{ Bindings: Env }>();

pay.get("/:token", getPaymentRequest);
pay.get("/:token/tx", getTransactionMetadata);
pay.post("/:token/tx", validateBody(transactionRequestBodySchema), createSponsoredTransaction);

export default pay;
