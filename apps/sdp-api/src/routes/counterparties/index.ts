import { Hono } from "hono";
import { unifiedAuthMiddleware } from "@/middleware/auth";
import { authorize, authorizeNone } from "@/middleware/authorize";
import { idempotent } from "@/middleware/idempotency";
import { projectContextMiddleware } from "@/middleware/project-context";
import { requireAction } from "@/middleware/require-action";
import { requireModule } from "@/middleware/require-module";
import { validateBody, validateParams } from "@/middleware/validate";
import { counterpartyAccounts } from "@/routes/counterparty-accounts";
import { counterpartyProviderAccounts } from "@/routes/counterparty-provider-accounts";
import type { Env } from "@/types/env";
import { authorizeCounterparty } from "./access";
import {
  archiveCounterparty,
  createCounterparty,
  getCounterparty,
  getCounterpartyFieldOptions,
  getCounterpartyRequirements,
  listCounterparties,
  listProjectCounterpartyAccounts,
  submitCounterpartyRequirements,
  updateCounterparty,
} from "./handlers";
import {
  counterpartyIdParamsSchema,
  createCounterpartySchema,
  submitCounterpartyRequirementsSchema,
  updateCounterpartySchema,
} from "./schemas";

export const counterparties = new Hono<{ Bindings: Env }>();

/** Why counterparty create runs `authorizeNone` (route inventory pins it). */
export const CREATES_IN_SCOPE =
  "creates a counterparty in the caller's own project; it names no existing resource";

// Ramp onboarding (provider KYC requirements, provider-owned accounts) lives here,
// not under /payments/ramps, so the ramps release channel gate has to cover it too.
counterparties.use("/:counterpartyId/requirements", requireModule("ramps"));
counterparties.use("/:counterpartyId/provider-accounts/*", requireModule("ramps"));
counterparties.use("*", unifiedAuthMiddleware());
counterparties.use("*", projectContextMiddleware());

counterparties.get("/metadata", requireAction("counterparties.read"), getCounterpartyFieldOptions);
counterparties.get(
  "/accounts",
  requireAction("counterparties.read"),
  listProjectCounterpartyAccounts
);
counterparties.get("/", requireAction("counterparties.read"), listCounterparties);
counterparties.post(
  "/",
  requireAction("counterparties.manage"),
  validateBody(createCounterpartySchema),
  authorizeNone(CREATES_IN_SCOPE),
  idempotent({ key: "accepted", serverErrors: "store" }),
  createCounterparty
);
counterparties.get("/:counterpartyId", requireAction("counterparties.read"), getCounterparty);
counterparties.get(
  "/:counterpartyId/requirements",
  requireAction("counterparties.read"),
  getCounterpartyRequirements
);
counterparties.post(
  "/:counterpartyId/requirements",
  requireAction("counterparties.execute"),
  validateBody(submitCounterpartyRequirementsSchema),
  submitCounterpartyRequirements
);
counterparties.patch(
  "/:counterpartyId",
  requireAction("counterparties.manage"),
  validateParams(counterpartyIdParamsSchema),
  validateBody(updateCounterpartySchema),
  authorize(authorizeCounterparty),
  idempotent({ key: "accepted", serverErrors: "store" }),
  updateCounterparty
);
counterparties.delete(
  "/:counterpartyId",
  requireAction("counterparties.manage"),
  validateParams(counterpartyIdParamsSchema),
  authorize(authorizeCounterparty),
  idempotent({ key: "accepted", serverErrors: "store" }),
  archiveCounterparty
);

counterparties.route("/:counterpartyId/accounts", counterpartyAccounts);
counterparties.route("/:counterpartyId/provider-accounts", counterpartyProviderAccounts);
