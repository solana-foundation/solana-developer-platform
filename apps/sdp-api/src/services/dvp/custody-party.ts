// The single custody derivation every later slice authorizes against.
//
// Given (org, project, party address) this resolves the active custody wallet
// whose public key is that address, re-read from the DB on every call. It is
// the per-address variant of `callerPartyAddresses` (inbound.ts) without
// key-scope filtering — callers layer that on top of the result.

import type { Address } from "@solana/kit";
import { getDb } from "@/db/client";
import { CustodyRuntimeTargets } from "@/services/domain/signing/custody-runtime-target";
import type { Env } from "@/types/env";

/**
 * Resolves the active custody wallet for a party address, re-reading from the
 * DB on every call — the single "can this caller act on this side" derivation,
 * and a stale read must not authorize a fund after an archive. An indexed
 * point read (`idx_custody_wallets_public_key`), never a list-and-filter.
 */
export async function custodyWalletForParty(
  env: Env,
  params: { organizationId: string; projectId: string },
  partyAddress: Address
): Promise<string | null> {
  return new CustodyRuntimeTargets(getDb(env), env, new Map()).findOperationalWalletIdByAddress({
    organizationId: params.organizationId,
    projectId: params.projectId,
    publicKey: partyAddress,
  });
}
