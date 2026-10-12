import { Hono } from "hono";
import { requirePermissions } from "@/middleware/auth";
import type { Env } from "@/types/env";
import { getWalletBalances } from "./handlers";

const walletBalances = new Hono<{ Bindings: Env }>();

walletBalances.get(
  "/:walletId/balances",
  requirePermissions("wallets:read", "payments:read"),
  getWalletBalances
);

export default walletBalances;
