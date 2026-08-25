import { HeliusRingsError } from "@sdp/helius-rings";
import type { Permission } from "@sdp/types";
import type { Context } from "hono";
import {
  createHeliusRingsOperationRepository,
  createHeliusRingsWalletRepository,
  createHeliusRingsZoneRepository,
  type HeliusRingsOperationRow,
  type HeliusRingsWalletRow,
} from "@/db/repositories";
import { getAuth } from "@/lib/auth";
import { AppError, type ErrorCode, notFound } from "@/lib/errors";
import {
  assertApiKeyWalletAccess,
  getAllowedApiKeyWalletIdsForPermissions,
} from "@/services/api-key-scope.service";
import { createHeliusRingsService, type HeliusRingsTenant } from "@/services/helius-rings";
import type { Env } from "@/types/env";

/** Hono request context bound to the app `Env`. */
export type AppContext = Context<{ Bindings: Env }>;

export function getHeliusRingsService(
  c: AppContext,
  tenant: { organizationId: string; projectId: string }
) {
  return createHeliusRingsService(c.env, tenant);
}

export function getHeliusRingsWalletRepository(c: AppContext) {
  return createHeliusRingsWalletRepository(c.env);
}

export function getHeliusRingsOperationRepository(c: AppContext) {
  return createHeliusRingsOperationRepository(c.env);
}

/**
 * Wallet-level authorization, on top of the route's project-level permission.
 *
 * An API key can be scoped to particular custody wallets. Without these checks
 * a key holding `payments:write` for one wallet could list this project's Rings
 * wallet ids and then spend from any of them — the route permission says what a
 * caller may do, not which wallet it may do it to. Payments enforces the same
 * guard on its equivalent operations.
 *
 * The guard is keyed on `sdp_wallet_id`, the custody provider's wallet id, which
 * is what API-key bindings name. Keys with no wallet scope are unaffected.
 */
async function assertRingsWalletAccess(
  c: AppContext,
  tenant: HeliusRingsTenant,
  walletId: string,
  permissions: Permission[]
): Promise<HeliusRingsWalletRow> {
  const wallet = await getHeliusRingsWalletRepository(c).getWalletById({ ...tenant, id: walletId });
  // 404 before the scope check: a key that cannot see this wallet learns the
  // same thing either way, and this keeps a missing id from reading as a
  // permission problem.
  if (!wallet) throw notFound("rings wallet");

  assertApiKeyWalletAccess(getAuth(c), wallet.sdp_wallet_id, permissions);
  return wallet;
}

export async function requireRingsWallet(
  c: AppContext,
  tenant: HeliusRingsTenant,
  walletId: string,
  permissions: Permission[]
): Promise<HeliusRingsWalletRow> {
  return assertRingsWalletAccess(c, tenant, walletId, permissions);
}

/** The same check reached through an operation, which names its wallet. */
export async function requireRingsOperation(
  c: AppContext,
  tenant: HeliusRingsTenant,
  operationId: string,
  permissions: Permission[]
): Promise<HeliusRingsOperationRow> {
  const operation = await getHeliusRingsOperationRepository(c).getOperationById({
    ...tenant,
    id: operationId,
  });
  if (!operation) throw notFound("rings operation");

  await assertRingsWalletAccess(c, tenant, operation.wallet_id, permissions);
  return operation;
}

/**
 * The `sdp_wallet_id` values this key may see, or null when it is unrestricted.
 *
 * List routes filter rather than throw: a scoped key asking for "my wallets"
 * wants its own, not a 403.
 */
export function allowedRingsWalletIds(
  c: AppContext,
  permissions: Permission[]
): ReadonlySet<string> | null {
  const allowed = getAllowedApiKeyWalletIdsForPermissions(getAuth(c), permissions);
  return allowed === null ? null : new Set(allowed);
}

export function getHeliusRingsZoneRepository(c: AppContext) {
  return createHeliusRingsZoneRepository(c.env);
}

const RINGS_ERROR_CODES: Record<HeliusRingsError["code"], ErrorCode> = {
  invalid_input: "BAD_REQUEST",
  not_found: "NOT_FOUND",
  conflict: "CONFLICT",
  gateway_unavailable: "SERVICE_UNAVAILABLE",
  config_error: "SERVICE_UNAVAILABLE",
  // The caller asked to move more than the wallet holds. Their request, not
  // our outage, and no amount of retrying changes it.
  insufficient_balance: "BAD_REQUEST",
  // A conflict a caller cannot resolve: an operator has to reconcile the
  // signature against the chain before anything else happens to this wallet.
  manual_reconciliation_required: "CONFLICT",
};

/** Path param, typed as present — the router only matches when it is. */
export function requireParam(c: AppContext, name: string): string {
  const value = c.req.param(name);
  if (!value) throw new AppError("BAD_REQUEST", `missing ${name}`);
  return value;
}

/** Runs a handler body, translating domain errors to API errors. */
export async function withRingsErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HeliusRingsError) {
      throw new AppError(RINGS_ERROR_CODES[error.code], error.message);
    }
    throw error;
  }
}
