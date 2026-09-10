import {
  DVP_SWAP_PROGRAM_PROGRAM_ADDRESS,
  DvpSwapProgramInstruction,
  identifyDvpSwapProgramInstruction,
} from "@sdp/dvp";
import { getSignaturesForAddress, getTransaction, type SolanaRpc } from "@sdp/rpc/solana";
import { type Address, getBase58Encoder, type Signature } from "@solana/kit";
import { internalError } from "@/lib/errors";

/** Position of `swap_dvp` in every SettleDvp, CancelDvp and RejectDvp account list. */
const SWAP_DVP_ACCOUNT_INDEX = 1;

export interface DvpCloseResolution {
  status: "settled" | "cancelled" | "rejected";
  signature: Signature;
}

/**
 * Finds and decodes the transaction that closed a vanished DvP account.
 *
 * @param rpc - Solana RPC client.
 * @param swapDvp - The vanished trade account address.
 * @returns The resolved close, or null when recent history contains none.
 */
export async function resolveDvpClose(
  rpc: SolanaRpc,
  swapDvp: Address
): Promise<DvpCloseResolution | null> {
  const history = await getSignaturesForAddress(rpc, swapDvp, { limit: 10 });
  for (const entry of history) {
    if (entry.err !== null) {
      continue;
    }
    const transaction = await getTransaction(rpc, entry.signature);
    if (transaction === null || transaction.err !== null) {
      continue;
    }
    for (const instruction of transaction.instructions) {
      if (
        instruction.programId !== DVP_SWAP_PROGRAM_PROGRAM_ADDRESS ||
        instruction.data === null ||
        instruction.data === undefined
      ) {
        continue;
      }
      const instructionData = instruction.data;
      let identified: DvpSwapProgramInstruction;
      try {
        identified = identifyDvpSwapProgramInstruction(getBase58Encoder().encode(instructionData));
      } catch {
        // Chain data, not ours: a discriminator this client does not know is an
        // instruction added to the program after this build. It cannot be a
        // close we recognise, so keep scanning older history.
        continue;
      }
      // A transaction touching this trade may also close another one, so a
      // closing instruction only counts when its `swap_dvp` account IS this
      // trade. Settle, Cancel and Reject all place it at index 1.
      const closesThisTrade = instruction.accounts[SWAP_DVP_ACCOUNT_INDEX] === swapDvp;
      switch (identified) {
        case DvpSwapProgramInstruction.SettleDvp:
          if (closesThisTrade) {
            return { status: "settled", signature: entry.signature };
          }
          break;
        case DvpSwapProgramInstruction.CancelDvp:
          if (closesThisTrade) {
            return { status: "cancelled", signature: entry.signature };
          }
          break;
        case DvpSwapProgramInstruction.RejectDvp:
          if (closesThisTrade) {
            return { status: "rejected", signature: entry.signature };
          }
          break;
        case DvpSwapProgramInstruction.CreateDvp:
        case DvpSwapProgramInstruction.ReclaimDvp:
        case DvpSwapProgramInstruction.RecoverDvp:
          break;
        default: {
          const unreachable: never = identified;
          throw internalError(`Unhandled DvP instruction ${String(unreachable)}`);
        }
      }
    }
  }
  return null;
}
