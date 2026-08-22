/**
 * Ownership binding for faucet (`requestAirdrop`) relays.
 *
 * The RPC relay forwards its payload verbatim, so before this guard the
 * airdrop destination was whatever address the caller typed — any tenant
 * could drip provider-funded SOL to wallets nobody in the platform owns.
 * A faucet destination must be a wallet of the AUTHENTICATED organization,
 * proven against the custody inventory, never against request input.
 */

import type { DatabaseClient } from "@/db/client";
import { badRequest, forbidden } from "@/lib/errors";

const FAUCET_METHOD = "requestAirdrop";

/** Base58 shape only — ownership is the real check, this just names bad input. */
const SOLANA_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Every airdrop destination in a relay payload — single request or JSON-RPC
 * batch. The batch shape matters: an ownership check that only covered the
 * relay's single-request faucet branch would be bypassed by wrapping the same
 * call in an array.
 *
 * @param payload - The validated relay payload (object or array of objects).
 * @returns The `params[0]` value of every `requestAirdrop` entry, unvalidated.
 */
export function extractAirdropDestinations(payload: unknown): unknown[] {
  const entries = Array.isArray(payload) ? payload : [payload];
  return entries
    .filter(
      (entry): entry is { method?: unknown; params?: unknown } =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as { method?: unknown }).method === FAUCET_METHOD
    )
    .map((entry) => (Array.isArray(entry.params) ? entry.params[0] : undefined));
}

/**
 * Refuse any `requestAirdrop` in the payload whose destination is not a
 * custody wallet of the authenticated organization.
 *
 * Ownership spans both custody models — config-owned and connection-owned
 * wallets — because either kind is a real tenant wallet a faucet may fund.
 * Scoped by organization alone: the org boundary is the security boundary,
 * and the relay's project semantics (an optional query hint) are too loose to
 * bind funding tighter without refusing legitimate org-level wallets.
 *
 * @param db - Database client.
 * @param organizationId - The authenticated organization (from auth, never input).
 * @param payload - The validated relay payload.
 * @throws AppError BAD_REQUEST for a malformed destination; FORBIDDEN for an unowned one.
 */
export async function assertFaucetDestinationsOwned(
  db: DatabaseClient,
  organizationId: string,
  payload: unknown
): Promise<void> {
  const rawDestinations = extractAirdropDestinations(payload);
  if (rawDestinations.length === 0) {
    return;
  }

  const destinations = new Set<string>();
  for (const destination of rawDestinations) {
    if (typeof destination !== "string" || !SOLANA_ADDRESS_PATTERN.test(destination)) {
      throw badRequest("requestAirdrop destination must be a base58 Solana address");
    }
    destinations.add(destination);
  }

  const addresses = [...destinations];
  const placeholders = addresses.map(() => "?").join(", ");
  // Only live inventory counts: a wallet that was deactivated — or whose
  // owning config/connection was — is no longer a wallet the tenant operates,
  // so the faucet must not fund it.
  const owned = await db.queryMany<{ public_key: string }>(
    `SELECT w.public_key
       FROM custody_wallets w
       JOIN custody_configs c ON c.id = w.custody_config_id
      WHERE c.organization_id = ?
        AND c.status = 'active'
        AND w.status = 'active'
        AND w.public_key IN (${placeholders})
      UNION
     SELECT w.public_key
       FROM custody_wallets w
       JOIN custody_connections cc ON cc.id = w.custody_connection_id
      WHERE cc.organization_id = ?
        AND cc.status = 'active'
        AND w.status = 'active'
        AND w.public_key IN (${placeholders})`,
    [organizationId, ...addresses, organizationId, ...addresses]
  );

  const ownedAddresses = new Set(owned.map((row) => row.public_key));
  for (const destination of destinations) {
    if (!ownedAddresses.has(destination)) {
      throw forbidden("requestAirdrop destination is not a wallet of this organization");
    }
  }
}
