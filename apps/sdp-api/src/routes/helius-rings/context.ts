import { HeliusRingsError } from "@sdp/helius-rings/errors";
import type { Context } from "hono";
import type { HeliusRingsOperationRow } from "@/db/repositories/helius-rings-operation.repository";
import type { HeliusRingsWalletRow } from "@/db/repositories/helius-rings-wallet.repository";
import {
  createHeliusRingsOperationRepository,
  createHeliusRingsWalletRepository,
  createHeliusRingsZoneRepository,
} from "@/db/repositories/repository-factory";
import { getAuth } from "@/lib/auth";
import { AppError, type ErrorCode, notFound } from "@/lib/errors";
import { assertCallerWalletInScope } from "@/lib/money-admission";
import { resolveScope, resolveWallet } from "@/routes/payments/wallets";
import { createHeliusRingsService, type HeliusRingsTenant } from "@/services/helius-rings/service";
import type { Env } from "@/types/env";

/** Hono request context bound to the app `Env`. */
export type AppContext = Context<{ Bindings: Env }>;

export function getHeliusRingsService(
  c: AppContext,
  tenant: { organizationId: string; projectId: string }
) {
  return createHeliusRingsService(c.env, tenant, { initiatedByKeyId: getAuth(c).apiKeyId });
}

export function getHeliusRingsWalletRepository(c: AppContext) {
  return createHeliusRingsWalletRepository(c.env);
}

export function getHeliusRingsOperationRepository(c: AppContext) {
  return createHeliusRingsOperationRepository(c.env);
}

/**
 * How a route uses the Rings wallet it names. A `read` is project-scoped. A
 * `write` also needs the wallet inside the key's wallet scope (HOO-2099): the
 * custody signer refuses one outside it, and refusing up front keeps the
 * operation from being prepared or sent to the gateway first.
 */
export type RingsWalletUse = "read" | "write";

/** The project's Rings wallet a route names, or 404; for a `write`, in the key's scope. */
export async function requireRingsWallet(
  c: AppContext,
  tenant: HeliusRingsTenant,
  walletId: string,
  use: RingsWalletUse
): Promise<HeliusRingsWalletRow> {
  const wallet = await getHeliusRingsWalletRepository(c).getWalletById({ ...tenant, id: walletId });
  if (!wallet) throw notFound("rings wallet");
  if (use === "write") await assertRingsWalletInScope(c, wallet);
  return wallet;
}

/** The project's Rings operation a route names, or 404; for a `write`, its wallet in the key's scope. */
export async function requireRingsOperation(
  c: AppContext,
  tenant: HeliusRingsTenant,
  operationId: string,
  use: RingsWalletUse
): Promise<HeliusRingsOperationRow> {
  const operation = await getHeliusRingsOperationRepository(c).getOperationById({
    ...tenant,
    id: operationId,
  });
  if (!operation) throw notFound("rings operation");
  if (use === "write") {
    await requireRingsWallet(c, tenant, operation.wallet_id, "write");
  }
  return operation;
}

/**
 * The key's scope lists exact custody wallet ids. A Rings wallet records the
 * custody wallet that signs for it; one created before live provisioning
 * names only the provider id, resolved to its one custody wallet (ambiguity
 * refuses, APE-390). An all-wallets key reads nothing more.
 */
async function assertRingsWalletInScope(
  c: AppContext,
  wallet: HeliusRingsWalletRow
): Promise<void> {
  const auth = getAuth(c);
  if (auth.walletAccess.scope === "all") return;
  const custodyWalletId =
    wallet.custody_wallet_id ??
    resolveWallet((await resolveScope(c)).wallets, wallet.sdp_wallet_id).id;
  assertCallerWalletInScope(auth, custodyWalletId);
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
  // Nothing signed and nothing broke: the wallet's custody provider cannot
  // serve Rings at all. A bad request rather than an outage, because the fix
  // is a different custody provider and not a retry.
  provider_unsupported: "BAD_REQUEST",
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
