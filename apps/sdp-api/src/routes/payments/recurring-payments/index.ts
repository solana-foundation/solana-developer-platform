import { Hono } from "hono";
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

const recurringPayments = new Hono<{ Bindings: Env }>();

recurringPayments.post(
  "/",
  requirePermissions("payments:write", "wallets:read", "counterparties:read"),
  requireAllowedOperation("recurring_payment_create"),
  validateBody(createRecurringPaymentSchema),
  authorize(authorizeRecurringPaymentCreate),
  // The schedule row carries its key (0129), so a 5xx re-runs and the row answers.
  idempotent({ key: "required", serverErrors: "rerun" }),
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
  // Each lifecycle attempt carries its key (0130), so a takeover or a 5xx re-run
  // is answered from the attempt instead of a 409 for the schedule mid-change.
  idempotent({ key: "accepted", serverErrors: "rerun" }),
  replayFromRecord(findRecurringPaymentUpdateReplay),
  updateRecurringPayment
);
recurringPayments.post(
  "/:id/activate",
  requirePermissions("payments:write", "wallets:read"),
  validateParams(recurringPaymentIdParamsSchema),
  validateBody(activateRecurringPaymentSchema),
  authorize(authorizeRecurringPayment),
  idempotent({ key: "required", serverErrors: "rerun" }),
  replayFromRecord(findRecurringPaymentActivateReplay),
  activateRecurringPayment
);
recurringPayments.post(
  "/:id/cancel",
  requirePermissions("payments:write", "wallets:read"),
  validateParams(recurringPaymentIdParamsSchema),
  validateBody(cancelRecurringPaymentSchema),
  authorize(authorizeRecurringPayment),
  idempotent({ key: "required", serverErrors: "rerun" }),
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
  idempotent({ key: "required", serverErrors: "rerun" }),
  replayFromRecord(findRecurringPaymentCollectReplay),
  collectRecurringPayment
);
recurringPayments.post(
  "/:id/resume",
  requirePermissions("payments:write", "wallets:read"),
  validateParams(recurringPaymentIdParamsSchema),
  validateBody(resumeRecurringPaymentSchema),
  authorize(authorizeRecurringPayment),
  idempotent({ key: "required", serverErrors: "rerun" }),
  replayFromRecord(findRecurringPaymentResumeReplay),
  resumeRecurringPayment
);
recurringPayments.get("/:id", requirePermissions("payments:read"), getRecurringPayment);

export default recurringPayments;
