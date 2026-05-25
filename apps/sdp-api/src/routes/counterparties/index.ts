import { Hono } from "hono";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import type { Env } from "@/types/env";
import {
  archiveCounterparty,
  createCounterparty,
  getCounterparty,
  listCounterparties,
  updateCounterparty,
} from "./handlers";

const counterparties = new Hono<{ Bindings: Env }>();

counterparties.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));

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

export default counterparties;
