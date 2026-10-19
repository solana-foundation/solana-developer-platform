import { Hono } from "hono";
import { requirePermissions } from "@/middleware/auth";
import type { Env } from "@/types/env";
import { listCounterpartyProviderAccounts } from "./handlers";

export const counterpartyProviderAccounts = new Hono<{ Bindings: Env }>();

counterpartyProviderAccounts.get(
  "/",
  requirePermissions("counterparties:read"),
  listCounterpartyProviderAccounts
);
