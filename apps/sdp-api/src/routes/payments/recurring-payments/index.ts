import { Hono } from "hono";
import { canonicalizeDecimalFields, type JsonValue } from "@/lib/idempotency";
import { authorize } from "@/middleware/authorize";
import { idempotent } from "@/middleware/idempotency";
import { replayFromRecord } from "@/middleware/movement-steps";
import { requireAction } from "@/middleware/require-action";
import { validateBody, validateParams } from "@/middleware/validate";
import type { Env } from "@/types/env";
import {
  authorizeRecurringPayment,
  authorizeRecurringPaymentCreate,
  authorizeRecurringPaymentStart,
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
  requireAction("recurring.manage"),
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
recurringPayments.get("/", requireAction("recurring.read"), listRecurringPayments);
recurringPayments.patch(
  "/:id",
  requireAction("recurring.execute"),
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
  requireAction("recurring.execute"),
  validateParams(recurringPaymentIdParamsSchema),
  validateBody(activateRecurringPaymentSchema),
  authorize((c, input) => authorizeRecurringPaymentStart(c, input, "recurring.activate")),
  idempotent({ key: "required", serverErrors: "rerun", recovery: "record" }),
  replayFromRecord(findRecurringPaymentActivateReplay),
  activateRecurringPayment
);
recurringPayments.post(
  "/:id/cancel",
  requireAction("recurring.manage"),
  validateParams(recurringPaymentIdParamsSchema),
  validateBody(cancelRecurringPaymentSchema),
  authorize(authorizeRecurringPayment),
  idempotent({ key: "required", serverErrors: "rerun", recovery: "record" }),
  replayFromRecord(findRecurringPaymentCancelReplay),
  cancelRecurringPayment
);
recurringPayments.post(
  "/:id/collect",
  requireAction("recurring.execute"),
  validateParams(recurringPaymentIdParamsSchema),
  validateBody(collectRecurringPaymentSchema),
  authorize((c, input) => authorizeRecurringPaymentStart(c, input, "recurring.collect")),
  idempotent({ key: "required", serverErrors: "rerun", recovery: "record" }),
  replayFromRecord(findRecurringPaymentCollectReplay),
  collectRecurringPayment
);
recurringPayments.post(
  "/:id/resume",
  requireAction("recurring.execute"),
  validateParams(recurringPaymentIdParamsSchema),
  validateBody(resumeRecurringPaymentSchema),
  authorize((c, input) => authorizeRecurringPaymentStart(c, input, "recurring.resume")),
  idempotent({ key: "required", serverErrors: "rerun", recovery: "record" }),
  replayFromRecord(findRecurringPaymentResumeReplay),
  resumeRecurringPayment
);
recurringPayments.get("/:id", requireAction("recurring.read"), getRecurringPayment);
