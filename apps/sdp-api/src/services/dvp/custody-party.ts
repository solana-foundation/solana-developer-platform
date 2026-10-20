// The single custody derivation every later slice authorizes against.
//
// Given (org, project, party address) this resolves the active custody wallet
// whose public key is that address, re-read from the DB on every call. It is
// the per-address variant of `callerPartyAddresses` (inbound.ts). The pick
// prefers a wallet the caller's scope lists; whether the caller may sign with
// it stays the custody signer's decision (HOO-2099).

import type { Address } from "@solana/kit";
import { type DatabaseClient, getDb } from "@/db/client";
import { type WalletAccess, walletAccessAllows } from "@/lib/auth";
import { CustodyRuntimeTargets } from "@/services/domain/signing/custody-runtime-target";
import type { Env } from "@/types/env";

/**
 * Resolves the active custody wallet for a party address — the single "can
 * this caller act on this side" derivation, re-read from the DB on every call
 * so a stale read never authorizes a fund after an archive. An address can be
 * held by multiple active records; {@link pickPartyWalletId} chooses.
 *
 * @param env - Runtime bindings used to resolve operational custody targets.
 * @param params - Tenant scope for the custody lookup.
 * @param params.organizationId - Organization that owns the custody wallet.
 * @param params.projectId - Project containing the custody wallet.
 * @param partyAddress - On-chain party address the wallet must hold.
 * @param walletAccess - The caller's wallet scope, from authentication.
 * @returns The `custody_wallets.id` to act as, or null.
 */
export async function custodyWalletForParty(
  env: Env,
  params: { organizationId: string; projectId: string },
  partyAddress: Address,
  walletAccess: WalletAccess
): Promise<string | null> {
  const ids = await new CustodyRuntimeTargets(
    getDb(env),
    env,
    new Map()
  ).findOperationalWalletIdsByAddress({
    organizationId: params.organizationId,
    projectId: params.projectId,
    publicKey: partyAddress,
  });
  return pickPartyWalletId(ids, walletAccess);
}

/**
 * The record to act as among the active ones holding a party address: the
 * first, in selection order, that the caller's scope lists, else the first.
 * A selected key that lists only a later record still funds with it; one
 * that lists none gets that first record, which the scope check refuses as
 * out of scope rather than as no wallet at all.
 *
 * @param ids - Operational wallet IDs holding the address, in selection order.
 * @param walletAccess - The caller's wallet scope, from authentication.
 * @returns The wallet ID to act as, or null when none holds the address.
 */
export function pickPartyWalletId(
  ids: readonly string[],
  walletAccess: WalletAccess
): string | null {
  return ids.find((id) => walletAccessAllows(walletAccess, id)) ?? ids[0] ?? null;
}

/**
 * Resolves a named active wallet only when it holds the party address.
 *
 * @param db - Database client used to read the custody wallet.
 * @param env - Runtime bindings used to resolve the operational target.
 * @param params - Tenant scope for the custody lookup.
 * @param params.organizationId - Organization that owns the custody wallet.
 * @param params.projectId - Project containing the custody wallet.
 * @param walletId - Custody wallet ID explicitly selected by the caller.
 * @param partyAddress - On-chain party address the wallet must hold.
 * @returns The custody wallet ID when it is active and holds the address, otherwise null.
 */
export async function walletIdIfHoldsAddress(
  db: DatabaseClient,
  env: Env,
  params: { organizationId: string; projectId: string },
  walletId: string,
  partyAddress: string
): Promise<string | null> {
  const wallet = await new CustodyRuntimeTargets(db, env, new Map()).findOperationalWalletById({
    organizationId: params.organizationId,
    projectId: params.projectId,
    custodyWalletId: walletId,
  });
  return wallet !== null && wallet.publicKey === partyAddress ? wallet.id : null;
}
