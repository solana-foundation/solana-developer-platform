// The single custody derivation every later slice authorizes against.
//
// Given (org, project, party address) this resolves the active custody wallet
// whose public key is that address, re-read from the DB on every call. It is
// the per-address variant of `callerPartyAddresses` (inbound.ts), with the
// caller's key-scope allowlist as an explicit input.

import type { Address } from "@solana/kit";
import { getDb } from "@/db/client";
import { CustodyRuntimeTargets } from "@/services/domain/signing/custody-runtime-target";
import type { Env } from "@/types/env";

/**
 * Resolves the active custody wallet for a party address — the single "can
 * this caller act on this side" derivation, re-read from the DB on every call
 * so a stale read never authorizes a fund after an archive. An address can be
 * held by multiple active records, so the pick is binding-aware: the first
 * match `allowedWalletIds` admits (null = unrestricted, [] = deny-all, the
 * repo-wide allowlist convention).
 *
 * @returns The `custody_wallets.id` to act as, or null.
 */
export async function custodyWalletForParty(
  env: Env,
  params: { organizationId: string; projectId: string },
  partyAddress: Address,
  allowedWalletIds: string[] | null
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
  const match = ids.find((id) => allowedWalletIds === null || allowedWalletIds.includes(id));
  return match === undefined ? null : match;
}
