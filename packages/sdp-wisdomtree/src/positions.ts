import { SPL_TOKEN_PROGRAMS } from "@sdp/types";
import type { WisdomTreeFund } from "@sdp/types/wisdomtree-programs";
import type { Address } from "@solana/kit";
import { address } from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token-2022";
import { formatBaseUnits } from "./amounts";
import { tokenAccountBaseUnits, type WisdomTreeChainReader } from "./chain";

/**
 * One owner's live holding in one fund, in base units of truth: the exact
 * integer amount from the owner's Token-2022 ATA, never `uiAmount` (the same
 * precision rule `@sdp/kamino`'s share-balance read follows).
 *
 * Fund tokens are the position — there is no vault share to convert and no
 * staking, so `shares` and `withdrawableShares` are the same figure, and a
 * missing ATA is an exact zero.
 */
export interface WisdomTreePositionRead {
  fund: WisdomTreeFund;
  owner: Address;
  /** Fund tokens held, as a decimal string at the mint's own scale. */
  shares: string;
}

export async function readWisdomTreePosition(
  reader: WisdomTreeChainReader,
  input: { fund: WisdomTreeFund; owner: Address }
): Promise<WisdomTreePositionRead> {
  const [ata] = await findAssociatedTokenPda({
    owner: input.owner,
    tokenProgram: address(SPL_TOKEN_PROGRAMS["token-2022"]),
    mint: address(input.fund.mint),
  });
  const account = await reader.getAccount(ata);
  const baseUnits = account === null ? 0n : tokenAccountBaseUnits(account.data);
  return {
    fund: input.fund,
    owner: input.owner,
    shares: formatBaseUnits(baseUnits, input.fund.decimals),
  };
}
