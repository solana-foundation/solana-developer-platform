import { Hono } from "hono";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { projectContextMiddleware } from "@/middleware/project-context";
import type { Env } from "@/types/env";
import {
  createOnrampQuote,
  createTransfer,
  executeOfframp,
  executeOnramp,
  getTransfer,
  getWalletBalances,
  getWalletPolicy,
  listOfframpCurrencies,
  listOnrampCurrencies,
  listTransfers,
  prepareTransfer,
  simulateSandboxTransfer,
  updateWalletPolicy,
} from "./handlers";

const payments = new Hono<{ Bindings: Env }>();

payments.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));
payments.use("*", projectContextMiddleware());

payments.get(
  "/wallets/:walletId/balances",
  requirePermissions("wallets:read", "payments:read"),
  getWalletBalances
);
payments.get(
  "/wallets/:walletId/policies",
  requirePermissions("wallets:read", "payments:read"),
  getWalletPolicy
);
payments.put(
  "/wallets/:walletId/policies",
  requirePermissions("wallets:write", "payments:write"),
  updateWalletPolicy
);
payments.post(
  "/transfers/prepare",
  requirePermissions("payments:write", "wallets:read"),
  prepareTransfer
);
payments.post("/transfers", requirePermissions("payments:write", "wallets:read"), createTransfer);
payments.get("/transfers", requirePermissions("payments:read"), listTransfers);
payments.get("/transfers/:transferId", requirePermissions("payments:read"), getTransfer);
payments.get("/ramps/onramp/currency", requirePermissions("payments:read"), listOnrampCurrencies);
payments.get("/ramps/offramp/currency", requirePermissions("payments:read"), listOfframpCurrencies);
payments.post(
  "/ramps/onramp/quote",
  requirePermissions("payments:write", "wallets:read"),
  createOnrampQuote
);
payments.post(
  "/ramps/onramp/execute",
  requirePermissions("payments:write", "wallets:read"),
  executeOnramp
);
payments.post(
  "/ramps/offramp/execute",
  requirePermissions("payments:write", "wallets:read"),
  executeOfframp
);
payments.post(
  "/ramps/sandbox/simulate",
  requirePermissions("payments:write"),
  simulateSandboxTransfer
);

export default payments;
