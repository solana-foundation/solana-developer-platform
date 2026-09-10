import {
  DVP_SWAP_PROGRAM_PROGRAM_ADDRESS,
  DvpSwapProgramInstruction,
  identifyDvpSwapProgramInstruction,
} from "@sdp/dvp";
import {
  getSignaturesForAddress,
  getTransaction,
  type ParsedInstruction,
  type SolanaRpc,
} from "@sdp/rpc/solana";
import { type Address, getBase58Encoder, type Signature } from "@solana/kit";
import { internalError } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";

/** Position of `swap_dvp` in every SettleDvp, CancelDvp and RejectDvp account list. */
const SWAP_DVP_ACCOUNT_INDEX = 1;
const HISTORY_PAGE_LIMIT = 100;
const HISTORY_PAGE_CAP = 10;

export interface DvpCloseResolution {
  status: "settled" | "cancelled" | "rejected";
  signature: Signature;
}

/**
 * Decodes a recognized close instruction that is bound to this trade.
 *
 * @param instruction - Parsed instruction from a successful transaction.
 * @param swapDvp - Trade account that must occupy the close account slot.
 * @returns The terminal status, or null when the instruction does not close this trade.
 */
function readCloseStatus(
  instruction: ParsedInstruction,
  swapDvp: Address
): DvpCloseResolution["status"] | null {
  if (
    instruction.programId !== DVP_SWAP_PROGRAM_PROGRAM_ADDRESS ||
    instruction.data === null ||
    instruction.data === undefined ||
    instruction.accounts[SWAP_DVP_ACCOUNT_INDEX] !== swapDvp
  ) {
    return null;
  }
  let identified: DvpSwapProgramInstruction;
  try {
    identified = identifyDvpSwapProgramInstruction(getBase58Encoder().encode(instruction.data));
  } catch {
    return null;
  }
  switch (identified) {
    case DvpSwapProgramInstruction.SettleDvp:
      return "settled";
    case DvpSwapProgramInstruction.CancelDvp:
      return "cancelled";
    case DvpSwapProgramInstruction.RejectDvp:
      return "rejected";
    case DvpSwapProgramInstruction.CreateDvp:
    case DvpSwapProgramInstruction.ReclaimDvp:
    case DvpSwapProgramInstruction.RecoverDvp:
      return null;
    default: {
      const unreachable: never = identified;
      throw internalError(`Unhandled DvP instruction ${String(unreachable)}`);
    }
  }
}

/**
 * Finds and decodes the transaction that closed a vanished DvP account.
 *
 * @param rpc - Solana RPC client.
 * @param swapDvp - The vanished trade account address.
 * @param tradeId - Stored trade id, used when capped history cannot be resolved.
 * @param createSignature - Signature that bounds this trade's relevant history.
 * @returns The resolved close, or null when recent history contains none.
 */
export async function resolveDvpClose(
  rpc: SolanaRpc,
  swapDvp: Address,
  tradeId: string,
  createSignature: Signature | null
): Promise<DvpCloseResolution | null> {
  let before: Signature | undefined;
  for (let page = 0; page < HISTORY_PAGE_CAP; page += 1) {
    const history = await getSignaturesForAddress(rpc, swapDvp, {
      limit: HISTORY_PAGE_LIMIT,
      ...(before === undefined ? {} : { before }),
    });
    for (const entry of history) {
      if (entry.signature === createSignature) {
        return null;
      }
      if (entry.err !== null) {
        continue;
      }
      const transaction = await getTransaction(rpc, entry.signature);
      if (transaction === null || transaction.err !== null) {
        continue;
      }
      for (const instruction of transaction.instructions) {
        const status = readCloseStatus(instruction, swapDvp);
        if (status !== null) {
          return { status, signature: entry.signature };
        }
      }
    }
    if (history.length < HISTORY_PAGE_LIMIT) {
      return null;
    }
    before = history[history.length - 1].signature;
  }
  getLogger().warn(
    { trade_id: tradeId, swap_dvp: swapDvp, pages: HISTORY_PAGE_CAP },
    "dvp close resolution reached the signature history page cap"
  );
  return null;
}
