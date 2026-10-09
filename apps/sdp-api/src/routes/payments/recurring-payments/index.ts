import { Hono } from "hono";
import { requireAllowedOperation } from "@/middleware/allowed-operations";
import { requirePermissions } from "@/middleware/auth";
import { idempotent } from "@/middleware/idempotency";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import { authorizeSourceWalletReplay } from "../wallets";
import {
  activateRecurringPayment,
  authorizeRecurringPaymentReplay,
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
  // The schedule row is written under its key (migration 0128), so a retry
  // after a 5xx re-runs and finds it (HOO-1918).
  idempotent({
    key: "required",
    serverErrors: "rerun",
    authorizeReplay: authorizeSourceWalletReplay,
  }),
  validateBody(createRecurringPaymentSchema),
  createRecurringPayment
);
recurringPayments.get("/", requirePermissions("payments:read"), listRecurringPayments);
recurringPayments.patch(
  "/:id",
  requirePermissions("payments:write", "wallets:read", "counterparties:read"),
  requireAllowedOperation("recurring_payment_update"),
  idempotent({ key: "accepted", authorizeReplay: authorizeRecurringPaymentReplay }),
  validateBody(updateRecurringPaymentSchema),
  updateRecurringPayment
);
recurringPayments.post(
  "/:id/activate",
  requirePermissions("payments:write", "wallets:read"),
  idempotent({ key: "required", authorizeReplay: authorizeRecurringPaymentReplay }),
  validateBody(activateRecurringPaymentSchema),
  activateRecurringPayment
);
recurringPayments.post(
  "/:id/cancel",
  requirePermissions("payments:write", "wallets:read"),
  idempotent({ key: "required", authorizeReplay: authorizeRecurringPaymentReplay }),
  validateBody(cancelRecurringPaymentSchema),
  cancelRecurringPayment
);
recurringPayments.post(
  "/:id/collect",
  requirePermissions("payments:write", "wallets:read"),
  requireAllowedOperation("recurring_payment_collection"),
  idempotent({ key: "required", authorizeReplay: authorizeRecurringPaymentReplay }),
  validateBody(collectRecurringPaymentSchema),
  collectRecurringPayment
);
recurringPayments.post(
  "/:id/resume",
  requirePermissions("payments:write", "wallets:read"),
  idempotent({ key: "required", authorizeReplay: authorizeRecurringPaymentReplay }),
  validateBody(resumeRecurringPaymentSchema),
  resumeRecurringPayment
);
recurringPayments.get("/:id", requirePermissions("payments:read"), getRecurringPayment);

export default recurringPayments;
