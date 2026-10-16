import { Hono } from "hono";
import { requireAllowedOperation } from "@/middleware/allowed-operations";
import { requirePermissions } from "@/middleware/auth";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import {
  activateRecurringPayment,
  cancelRecurringPayment,
  collectRecurringPayment,
  createRecurringPayment,
  getRecurringPayment,
  listRecurringPayments,
  resumeRecurringPayment,
  updateRecurringPayment,
} from "./handlers";
import {
  activateRecurringPaymentSchema,
  cancelRecurringPaymentSchema,
  collectRecurringPaymentSchema,
  createRecurringPaymentSchema,
  resumeRecurringPaymentSchema,
  updateRecurringPaymentSchema,
} from "./schemas";

const recurringPayments = new Hono<{ Bindings: Env }>();

recurringPayments.post(
  "/",
  requirePermissions("payments:write", "wallets:read", "counterparties:read"),
  requireAllowedOperation("recurring_payment_create"),
  validateBody(createRecurringPaymentSchema),
  createRecurringPayment
);
recurringPayments.get("/", requirePermissions("payments:read"), listRecurringPayments);
recurringPayments.patch(
  "/:id",
  requirePermissions("payments:write", "wallets:read", "counterparties:read"),
  requireAllowedOperation("recurring_payment_update"),
  validateBody(updateRecurringPaymentSchema),
  updateRecurringPayment
);
recurringPayments.post(
  "/:id/activate",
  requirePermissions("payments:write", "wallets:read"),
  validateBody(activateRecurringPaymentSchema),
  activateRecurringPayment
);
recurringPayments.post(
  "/:id/cancel",
  requirePermissions("payments:write", "wallets:read"),
  validateBody(cancelRecurringPaymentSchema),
  cancelRecurringPayment
);
recurringPayments.post(
  "/:id/collect",
  requirePermissions("payments:write", "wallets:read"),
  requireAllowedOperation("recurring_payment_collection"),
  validateBody(collectRecurringPaymentSchema),
  collectRecurringPayment
);
recurringPayments.post(
  "/:id/resume",
  requirePermissions("payments:write", "wallets:read"),
  validateBody(resumeRecurringPaymentSchema),
  resumeRecurringPayment
);
recurringPayments.get("/:id", requirePermissions("payments:read"), getRecurringPayment);

export default recurringPayments;
