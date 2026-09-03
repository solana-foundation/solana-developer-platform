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

import { getAccountInfo, type SolanaRpc } from "@sdp/rpc/solana";
import type { Address } from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token-2022";

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

const SETTLE_ATA_KEYS = Object.keys(SETTLE_ATA_DESCRIPTIONS) as (keyof DvpSettleAtas)[];

/**
 * Reports which of Settle's required accounts do not yet exist.
 *
 * Returns the KEYS rather than formatted strings so a caller can act on the
 * answer — creating the missing accounts — without parsing prose back apart.
 *
 * @param rpc - Solana RPC for the trade's cluster.
 * @param atas - The derived accounts from {@link deriveDvpSettleAtas}.
 * @returns The subset that must be created, empty when all four exist.
 */
export async function findMissingSettleAtas(
  rpc: SolanaRpc,
  atas: DvpSettleAtas
): Promise<ReadonlySet<keyof DvpSettleAtas>> {
  const accounts = await Promise.all(SETTLE_ATA_KEYS.map((key) => getAccountInfo(rpc, atas[key])));
  return new Set(SETTLE_ATA_KEYS.filter((_, index) => !accounts[index]));
}

/** Names a missing account and what it is for, for an error message. */
export function describeMissingSettleAta(key: keyof DvpSettleAtas, atas: DvpSettleAtas): string {
  return `${atas[key]} does not exist and must be created before settling: it is ${SETTLE_ATA_DESCRIPTIONS[key]}`;
}

/**
 * Rent-exempt minimum for a token account, plus a fee allowance.
 *
 * Settling can create up to four token accounts and always pays a signature
 * fee, and all of it comes from the settlement authority. The figure is a floor
 * rather than a quote: it exists to catch an authority holding nothing, which is
 * the state every freshly provisioned one is in.
 */
const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_040_000n;
const FEE_ALLOWANCE_LAMPORTS = 50_000n;

/**
 * What settling will cost the settlement authority, in lamports.
 *
 * @param accountsToCreate - How many token accounts this close must open.
 */
export function estimateSettlementCostLamports(accountsToCreate: number): bigint {
  return BigInt(accountsToCreate) * TOKEN_ACCOUNT_RENT_LAMPORTS + FEE_ALLOWANCE_LAMPORTS;
}

/**
 * Whether the settlement authority can pay for the close it is about to sign.
 *
 * The authority is provisioned on a project's first trade and starts empty.
 * Nothing funds it, so without this the first settle in every project failed in
 * simulation with "Attempt to debit an account but found no record of a prior
 * credit" — an error that names neither the account nor the reason, arrives
 * nested two levels inside a SolanaError cause, and reached the dashboard as
 * "An internal error occurred".
 *
 * @param rpc - Solana RPC for the trade's cluster.
 * @param authority - The settlement authority that signs and pays.
 * @param accountsToCreate - Token accounts this close has to open.
 * @returns The shortfall in lamports, or null when the balance is sufficient.
 */
export async function findSettlementFundingShortfall(
  rpc: SolanaRpc,
  authority: Address,
  accountsToCreate: number
): Promise<{ balance: bigint; required: bigint; shortfall: bigint } | null> {
  const required = estimateSettlementCostLamports(accountsToCreate);
  const account = await getAccountInfo(rpc, authority);

  // An account that is not there holds nothing, and that is the case this
  // exists for. But a response that HAS an account and no readable lamports is
  // an RPC anomaly, not a balance of zero — reading it as zero would refuse a
  // settlement that would have worked. Unknown means "do not block"; the chain
  // still enforces the real thing.
  const lamports = account?.lamports;
  if (account && typeof lamports !== "number" && typeof lamports !== "bigint") {
    return null;
  }

  const balance = account ? BigInt(lamports as number | bigint) : 0n;
  return balance >= required ? null : { balance, required, shortfall: required - balance };
}
