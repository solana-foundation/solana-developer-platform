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
 * and a stale read must not authorize a fund after an archive. Active-only via
 * `CustodyRuntimeTargets.listWallets`, which already filters `w.status`.
 */
export async function custodyWalletForParty(
  env: Env,
  params: { organizationId: string; projectId: string },
  partyAddress: Address
): Promise<string | null> {
  const wallets = await new CustodyRuntimeTargets(getDb(env), env, new Map()).listWallets({
    organizationId: params.organizationId,
    projectId: params.projectId,
    includeAllProviders: true,
  });

  // A project can in principle hold the same address under two records; the
  // first match is the same wallet either way, so linear find is correct.
  const match = wallets.find((wallet) => wallet.publicKey === partyAddress);
  return match === undefined ? null : match.id;
}
