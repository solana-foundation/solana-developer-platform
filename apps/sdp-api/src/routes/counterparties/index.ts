import { Hono } from "hono";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { projectContextMiddleware } from "@/middleware/project-context";
import { validateBody } from "@/middleware/validate";
import { submitCounterpartyRequirementsSchema } from "@/routes/payments/schemas";
import type { Env } from "@/types/env";
import counterpartyAccounts from "../counterparty-accounts";
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
import { createCounterpartySchema, updateCounterpartySchema } from "./schemas";

const counterparties = new Hono<{ Bindings: Env }>();

counterparties.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));
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
  validateBody(updateCounterpartySchema),
  updateCounterparty
);
counterparties.delete(
  "/:counterpartyId",
  requirePermissions("counterparties:write"),
  archiveCounterparty
);

counterparties.route("/:counterpartyId/accounts", counterpartyAccounts);

export default counterparties;
