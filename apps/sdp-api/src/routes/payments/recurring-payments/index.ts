import { Hono } from "hono";
import { canonicalizeDecimalFields, type JsonValue } from "@/lib/idempotency";
import { requireAllowedOperation } from "@/middleware/allowed-operations";
import { requirePermissions } from "@/middleware/auth";
import { authorize } from "@/middleware/authorize";
import { idempotent } from "@/middleware/idempotency";
import { replayFromRecord } from "@/middleware/movement-steps";
import { validateBody, validateParams } from "@/middleware/validate";
import type { Env } from "@/types/env";
import {
  authorizeRecurringPayment,
  authorizeRecurringPaymentCreate,
  authorizeRecurringPaymentUpdate,
} from "./access";
import {
  activateRecurringPayment,
  cancelRecurringPayment,
  collectRecurringPayment,
  createRecurringPayment,
  findRecurringPaymentActivateReplay,
  findRecurringPaymentCancelReplay,
  findRecurringPaymentCollectReplay,
  findRecurringPaymentCreateReplay,
  findRecurringPaymentResumeReplay,
  findRecurringPaymentUpdateReplay,
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
  recurringPaymentIdParamsSchema,
  resumeRecurringPaymentSchema,
  updateRecurringPaymentSchema,
} from "./schemas";

export const recurringPayments = new Hono<{ Bindings: Env }>();

/** "1.0" and "1" collect the same amount, so they fingerprint as one request. */
const canonicalAmount = (body: JsonValue) => canonicalizeDecimalFields(body, ["amount"]);

recurringPayments.post(
  "/",
  requirePermissions("payments:write", "wallets:read", "counterparties:read"),
  requireAllowedOperation("recurring_payment_create"),
  validateBody(createRecurringPaymentSchema),
  authorize(authorizeRecurringPaymentCreate),
  // The schedule row carries its key (0134), so a 5xx re-runs and the row answers.
  idempotent({
    key: "required",
    serverErrors: "rerun",
    recovery: "record",
    canonicalize: canonicalAmount,
  }),
  replayFromRecord(findRecurringPaymentCreateReplay),
  createRecurringPayment
);
recurringPayments.get("/", requirePermissions("payments:read"), listRecurringPayments);
recurringPayments.patch(
  "/:id",
  requirePermissions("payments:write", "wallets:read", "counterparties:read"),
  requireAllowedOperation("recurring_payment_update"),
  validateParams(recurringPaymentIdParamsSchema),
  validateBody(updateRecurringPaymentSchema),
  authorize(authorizeRecurringPaymentUpdate),
  // Editing an active schedule signs and broadcasts a replacement subscription,
  // so a retry without the key could broadcast twice: the key is required.
  // Each lifecycle attempt carries its key (0135), so a takeover or a 5xx re-run
  // is answered from the attempt instead of a 409 for the schedule mid-change.
  idempotent({
    key: "required",
    serverErrors: "rerun",
    recovery: "record",
    canonicalize: canonicalAmount,
  }),
  replayFromRecord(findRecurringPaymentUpdateReplay),
  updateRecurringPayment
);
recurringPayments.post(
  "/:id/activate",
  requirePermissions("payments:write", "wallets:read"),
  validateParams(recurringPaymentIdParamsSchema),
  validateBody(activateRecurringPaymentSchema),
  authorize(authorizeRecurringPayment),
  idempotent({ key: "required", serverErrors: "rerun", recovery: "record" }),
  replayFromRecord(findRecurringPaymentActivateReplay),
  activateRecurringPayment
);
recurringPayments.post(
  "/:id/cancel",
  requirePermissions("payments:write", "wallets:read"),
  validateParams(recurringPaymentIdParamsSchema),
  validateBody(cancelRecurringPaymentSchema),
  authorize(authorizeRecurringPayment),
  idempotent({ key: "required", serverErrors: "rerun", recovery: "record" }),
  replayFromRecord(findRecurringPaymentCancelReplay),
  cancelRecurringPayment
);
recurringPayments.post(
  "/:id/collect",
  requirePermissions("payments:write", "wallets:read"),
  requireAllowedOperation("recurring_payment_collection"),
  validateParams(recurringPaymentIdParamsSchema),
  validateBody(collectRecurringPaymentSchema),
  authorize(authorizeRecurringPayment),
  idempotent({ key: "required", serverErrors: "rerun", recovery: "record" }),
  replayFromRecord(findRecurringPaymentCollectReplay),
  collectRecurringPayment
);
recurringPayments.post(
  "/:id/resume",
  requirePermissions("payments:write", "wallets:read"),
  validateParams(recurringPaymentIdParamsSchema),
  validateBody(resumeRecurringPaymentSchema),
  authorize(authorizeRecurringPayment),
  idempotent({ key: "required", serverErrors: "rerun", recovery: "record" }),
  replayFromRecord(findRecurringPaymentResumeReplay),
  resumeRecurringPayment
);
recurringPayments.get("/:id", requirePermissions("payments:read"), getRecurringPayment);
