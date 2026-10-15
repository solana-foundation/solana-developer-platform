import { HeliusRingsError } from "@sdp/helius-rings";
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
import { createHeliusRingsService, type HeliusRingsTenant } from "@/services/helius-rings";
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
 * The project's Rings wallet a route names, or 404. Project-scoped: whether
 * the caller may sign with its custody wallet is the custody signer's decision
 * (HOO-2099).
 */
export async function requireRingsWallet(
  c: AppContext,
  tenant: HeliusRingsTenant,
  walletId: string
): Promise<HeliusRingsWalletRow> {
  const wallet = await getHeliusRingsWalletRepository(c).getWalletById({ ...tenant, id: walletId });
  if (!wallet) throw notFound("rings wallet");
  return wallet;
}

/** The project's Rings operation a route names, or 404. */
export async function requireRingsOperation(
  c: AppContext,
  tenant: HeliusRingsTenant,
  operationId: string
): Promise<HeliusRingsOperationRow> {
  const operation = await getHeliusRingsOperationRepository(c).getOperationById({
    ...tenant,
    id: operationId,
  });
  if (!operation) throw notFound("rings operation");
  return operation;
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
