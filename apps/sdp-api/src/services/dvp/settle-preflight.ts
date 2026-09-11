/**
 * What has to be true before `SettleDvp` is worth sending.
 *
 * Settle takes four token accounts beyond the two escrows, and the program
 * requires every one of them to already exist. Two are the delivery
 * destinations; the other two are surplus-refund destinations, and the reason
 * they are mandatory even when there is no surplus is worth stating plainly,
 * because it is a griefing vector rather than an edge case — from the
 * instruction's own account docs:
 *
 *   "Required and must be pre-initialized: anyone can dust the escrow, forcing
 *    a surplus refund, and a missing ATA reverts the whole Settle"
 *
 * So a stranger can send one token unit to an escrow and make settlement
 * impossible for a trade whose refund ATA was never created. Checking here turns
 * that into a named 400 before we spend a signature, and gives an operator the
 * exact account to create.
 */

import type { SolanaRpc } from "@sdp/rpc/solana";
import { type Address, fetchEncodedAccounts } from "@solana/kit";
import { findAssociatedTokenPda, getTokenDecoder } from "@solana-program/token-2022";
import { badRequest } from "@/lib/errors";

export interface DvpSettleParties {
  userA: Address;
  userB: Address;
  userASettlementDestination: Address;
  userBSettlementDestination: Address;
  mintA: Address;
  mintB: Address;
  tokenProgramA: Address;
  tokenProgramB: Address;
}

/** The four addresses Settle needs, alongside the two escrows. */
export interface DvpSettleAtas {
  /** user_a's settlement destination's ATA for mint_b. Receives the cash leg. */
  userADestinationAtaB: Address;
  /** user_b's settlement destination's ATA for mint_a. Receives the asset leg. */
  userBDestinationAtaA: Address;
  /** user_a's own ATA for mint_a. Receives any asset-leg surplus refund. */
  userAAtaA: Address;
  /** user_b's own ATA for mint_b. Receives any cash-leg surplus refund. */
  userBAtaB: Address;
}

async function ata(owner: Address, mint: Address, tokenProgram: Address): Promise<Address> {
  const [derived] = await findAssociatedTokenPda({ owner, mint, tokenProgram });
  return derived;
}

/**
 * Derives the four token accounts `SettleDvp` requires.
 *
 * @param parties - The trade's parties, destinations, mints and token programs.
 * @returns The four addresses, in the order the instruction names them.
 */
export async function deriveDvpSettleAtas(parties: DvpSettleParties): Promise<DvpSettleAtas> {
  const [userADestinationAtaB, userBDestinationAtaA, userAAtaA, userBAtaB] = await Promise.all([
    // Each party receives the OTHER leg's mint, which is the whole point of the
    // trade — so the destination ATAs cross over.
    ata(parties.userASettlementDestination, parties.mintB, parties.tokenProgramB),
    ata(parties.userBSettlementDestination, parties.mintA, parties.tokenProgramA),
    // Refunds go back in the leg's OWN mint, to the depositor, so these do not.
    ata(parties.userA, parties.mintA, parties.tokenProgramA),
    ata(parties.userB, parties.mintB, parties.tokenProgramB),
  ]);
  return { userADestinationAtaB, userBDestinationAtaA, userAAtaA, userBAtaB };
}

/** What each account is for, used when naming a missing one. */
export const SETTLE_ATA_DESCRIPTIONS: Readonly<Record<keyof DvpSettleAtas, string>> = {
  userADestinationAtaB: "the cash leg's delivery account for user A",
  userBDestinationAtaA: "the asset leg's delivery account for user B",
  userAAtaA: "user A's surplus-refund account",
  userBAtaB: "user B's surplus-refund account",
};

/**
 * Reports which of Settle's required accounts do not yet exist.
 *
 * Returns the KEYS rather than formatted strings so a caller can act on the
 * answer — creating the missing accounts — without parsing prose back apart.
 *
 * @param rpc - Solana RPC for the trade's cluster.
 * @param atas - The derived accounts from {@link deriveDvpSettleAtas}.
 * @param keys - Accounts used by the requested close action.
 * @returns The subset that must be created, empty when all four exist.
 */
export async function findMissingSettleAtas(
  rpc: SolanaRpc,
  atas: DvpSettleAtas,
  parties: DvpSettleParties,
  keys: readonly (keyof DvpSettleAtas)[]
): Promise<ReadonlySet<keyof DvpSettleAtas>> {
  const accounts = await fetchEncodedAccounts(
    rpc,
    keys.map((key) => atas[key])
  );
  const expected = {
    userADestinationAtaB: {
      tokenProgram: parties.tokenProgramB,
      owner: parties.userASettlementDestination,
    },
    userBDestinationAtaA: {
      tokenProgram: parties.tokenProgramA,
      owner: parties.userBSettlementDestination,
    },
    userAAtaA: { tokenProgram: parties.tokenProgramA, owner: parties.userA },
    userBAtaB: { tokenProgram: parties.tokenProgramB, owner: parties.userB },
  } as const satisfies Record<keyof DvpSettleAtas, { tokenProgram: Address; owner: Address }>;
  const missing = new Set<keyof DvpSettleAtas>();
  for (const [index, key] of keys.entries()) {
    const account = accounts[index];
    if (!account.exists) {
      missing.add(key);
      continue;
    }
    if (account.programAddress !== expected[key].tokenProgram) {
      throw badRequest(
        `DvP token account ${account.address} is owned by ${account.programAddress}, not the leg's token program ${expected[key].tokenProgram}`
      );
    }
    let token: ReturnType<ReturnType<typeof getTokenDecoder>["decode"]>;
    try {
      token = getTokenDecoder().decode(account.data);
    } catch {
      throw badRequest(`DvP token account ${account.address} cannot be decoded`);
    }
    if (token.owner !== expected[key].owner) {
      throw badRequest(
        `DvP token account ${account.address} was reassigned and is no longer owned by ${expected[key].owner}`
      );
    }
  }
  return missing;
}

/** Names a missing account and what it is for, for an error message. */
export function describeMissingSettleAta(key: keyof DvpSettleAtas, atas: DvpSettleAtas): string {
  return `${atas[key]} does not exist and must be created before settling: it is ${SETTLE_ATA_DESCRIPTIONS[key]}`;
}
