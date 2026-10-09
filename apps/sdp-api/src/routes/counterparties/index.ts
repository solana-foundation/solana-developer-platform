import { Hono } from "hono";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { idempotent } from "@/middleware/idempotency";
import { projectContextMiddleware } from "@/middleware/project-context";
import { requireModule } from "@/middleware/require-module";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import counterpartyAccounts from "../counterparty-accounts";
import counterpartyProviderAccounts from "../counterparty-provider-accounts";
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
  createCounterpartySchema,
  submitCounterpartyRequirementsSchema,
  updateCounterpartySchema,
} from "./schemas";

const counterparties = new Hono<{ Bindings: Env }>();

// Ramp onboarding (provider KYC requirements, provider-owned accounts) lives here,
// not under /payments/ramps, so the ramps release channel gate has to cover it too.
counterparties.use("/:counterpartyId/requirements", requireModule("ramps"));
counterparties.use("/:counterpartyId/provider-accounts/*", requireModule("ramps"));
counterparties.use("*", unifiedAuthMiddleware());
counterparties.use("*", projectContextMiddleware());

counterparties.get(
  "/metadata",
  requirePermissions("counterparties:read"),
  getCounterpartyFieldOptions
);
counterparties.get(
  "/accounts",
  requirePermissions("counterparties:read"),
  listProjectCounterpartyAccounts
);
counterparties.get("/", requirePermissions("counterparties:read"), listCounterparties);
counterparties.post(
  "/",
  requirePermissions("counterparties:write"),
  idempotent({ key: "accepted" }),
  validateBody(createCounterpartySchema),
  createCounterparty
);
counterparties.get("/:counterpartyId", requirePermissions("counterparties:read"), getCounterparty);
counterparties.get(
  "/:counterpartyId/requirements",
  requirePermissions("counterparties:read"),
  getCounterpartyRequirements
);
counterparties.post(
  "/:counterpartyId/requirements",
  requirePermissions("counterparties:write"),
  validateBody(submitCounterpartyRequirementsSchema),
  submitCounterpartyRequirements
);
counterparties.patch(
  "/:counterpartyId",
  requirePermissions("counterparties:write"),
  idempotent({ key: "accepted" }),
  validateBody(updateCounterpartySchema),
  updateCounterparty
);
counterparties.delete(
  "/:counterpartyId",
  requirePermissions("counterparties:write"),
  archiveCounterparty
);

counterparties.route("/:counterpartyId/accounts", counterpartyAccounts);
counterparties.route("/:counterpartyId/provider-accounts", counterpartyProviderAccounts);

export default counterparties;
