import { Hono } from "hono";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { projectContextMiddleware } from "@/middleware/project-context";
import type { Env } from "@/types/env";
import counterpartyAccounts from "../counterparty-accounts";
import {
  archiveCounterparty,
  createCounterparty,
  getCounterparty,
  listCounterparties,
  updateCounterparty,
} from "./handlers";

const counterparties = new Hono<{ Bindings: Env }>();

counterparties.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));
counterparties.use("*", projectContextMiddleware());

counterparties.get("/", requirePermissions("counterparties:read"), listCounterparties);
counterparties.post("/", requirePermissions("counterparties:write"), createCounterparty);
counterparties.get("/:counterpartyId", requirePermissions("counterparties:read"), getCounterparty);
counterparties.patch(
  "/:counterpartyId",
  requirePermissions("counterparties:write"),
  updateCounterparty
);
counterparties.delete(
  "/:counterpartyId",
  requirePermissions("counterparties:write"),
  archiveCounterparty
);

counterparties.route("/:counterpartyId/accounts", counterpartyAccounts);

export default counterparties;
