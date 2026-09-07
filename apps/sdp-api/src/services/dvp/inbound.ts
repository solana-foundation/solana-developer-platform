/**
 * Trades waiting on this caller, that somebody else created.
 *
 * An agent trade names two parties who were not in the room when it was set up
 * (PRO-1853), so without this neither of them learns the trade exists unless
 * the address reaches them out of band. That is the gap this closes.
 *
 * The filter is the caller's OWN custody wallet addresses, resolved here. There
 * is deliberately no address parameter: a party address is the only input this
 * would need, so accepting one would turn the endpoint into an oracle for
 * enumerating any address's trades — including addresses belonging to somebody
 * who has never used the product.
 */

import { getDb } from "@/db/client";
import { createDvpTradeRepository, type DvpTradeRow, type DvpTradeSide } from "@/db/repositories";
import type { ApiKeyContext } from "@/lib/auth";
import { getAllowedApiKeyCustodyWalletIdsForPermissions } from "@/services/api-key-scope.service";
import { CustodyRuntimeTargets } from "@/services/domain/signing/custody-runtime-target";
import type { Env } from "@/types/env";

/** How many inbound trades a single read returns. */
export const DVP_INBOUND_LIMIT = 50;

export interface DvpInboundRequest {
  organizationId: string;
  projectId: string;
  auth: ApiKeyContext;
}

/** A trade naming the caller, and which leg is theirs. */
export interface DvpInboundTrade {
  trade: DvpTradeRow;
  /** The leg this caller is party to. Both, when they hold both addresses. */
  side: DvpTradeSide;
  /** The address of theirs that matched, so the UI can say which wallet. */
  party: string;
}

/**
 * The caller's own custody wallet addresses.
 *
 * Scoped the same way `/v1/wallets` scopes its listing, through
 * `getAllowedApiKeyCustodyWalletIdsForPermissions`, so a key bound to a subset
 * of wallets discovers trades for that subset and no more. Without it a
 * narrowly bound key would learn about trades naming wallets it has no rights
 * over, which is the same disclosure the binding exists to prevent.
 */
async function callerPartyAddresses(
  env: Env,
  request: DvpInboundRequest
): Promise<Map<string, string>> {
  const allowedWalletIds = getAllowedApiKeyCustodyWalletIdsForPermissions(request.auth, [
    "wallets:read",
  ]);
  if (allowedWalletIds !== null && allowedWalletIds.length === 0) {
    return new Map();
  }

  const wallets = await new CustodyRuntimeTargets(getDb(env), env, new Map()).listWallets({
    organizationId: request.organizationId,
    projectId: request.projectId,
    includeAllProviders: true,
  });

  const visible =
    allowedWalletIds === null
      ? wallets
      : wallets.filter((wallet) => allowedWalletIds.includes(wallet.id));

  // Keyed by address because that is what a trade names. A project can hold the
  // same address under two records in principle; last one wins and either is
  // the same wallet.
  return new Map(
    visible
      .filter((wallet) => typeof wallet.publicKey === "string" && wallet.publicKey.length > 0)
      .map((wallet) => [wallet.publicKey as string, wallet.id])
  );
}

/**
 * Open trades created elsewhere that name one of this caller's wallets.
 *
 * Returns an empty list rather than throwing when the caller holds no wallets:
 * having none is an ordinary state for a new project, not an error, and a 500
 * on an empty dashboard panel would be worse than an empty panel.
 */
export async function listInboundDvpTrades(
  env: Env,
  request: DvpInboundRequest
): Promise<DvpInboundTrade[]> {
  const addressesToWallet = await callerPartyAddresses(env, request);
  if (addressesToWallet.size === 0) {
    return [];
  }

  const repository = createDvpTradeRepository(env);
  const rows = await repository.listInboundForParty(
    {
      organizationId: request.organizationId,
      projectId: request.projectId,
      partyAddresses: [...addressesToWallet.keys()],
    },
    DVP_INBOUND_LIMIT
  );

  return rows.flatMap((trade) => {
    // Which leg is theirs decides what the row says and, later, which escrow
    // they fund. Leg A is checked first so a caller holding BOTH addresses gets
    // a stable answer rather than one that depends on row order.
    const side: DvpTradeSide | null = addressesToWallet.has(trade.userA)
      ? "a"
      : addressesToWallet.has(trade.userB)
        ? "b"
        : null;

    // The database returned it, so a wallet of ours matches one of the parties.
    // If neither does, the query and the policy disagree and the safe reading
    // is to show nothing rather than guess a side and point somebody at the
    // wrong escrow.
    if (side === null) {
      return [];
    }

    return [{ trade, side, party: side === "a" ? trade.userA : trade.userB }];
  });
}
