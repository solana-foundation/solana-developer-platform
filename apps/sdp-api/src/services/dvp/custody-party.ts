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
 * DB on every call.
 *
 * This is the single custody derivation of the DvP per-side ownership reshape:
 * "can this caller act on this side" is answered here and only here. The
 * re-read is deliberate — authorization at act time must not trust a stale
 * resolution. A wallet archived between a create and a fund must make the fund
 * refuse, and only a fresh DB read sees that.
 *
 * Only ACTIVE wallets qualify. `CustodyRuntimeTargets.listWallets` already
 * filters `w.status = 'active'` in both its config-backed and connection-backed
 * wallet queries, so archived wallets never appear in the result — this relies
 * on that filter rather than re-applying it.
 *
 * @param env - The request environment, used to open the DB connection.
 * @param params.organizationId - The caller's organization id.
 * @param params.projectId - The caller's project id.
 * @param partyAddress - The on-chain address to resolve against.
 * @returns The matching active custody wallet's `custody_wallets.id`, or null
 *   when no active wallet in scope holds that address.
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
