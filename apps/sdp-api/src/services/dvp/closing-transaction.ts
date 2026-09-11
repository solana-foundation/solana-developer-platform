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

/** Position of `swap_dvp` in every SettleDvp, CancelDvp and RejectDvp account list. */
const SWAP_DVP_ACCOUNT_INDEX = 1;
const HISTORY_PAGE_LIMIT = 100;
const HISTORY_PAGE_CAP = 10;
/** Maximum tolerated difference between SDP and validator clocks around create. */
export const CREATE_TIME_SKEW_SECONDS = 300;

export interface DvpCloseResolution {
  status: "settled" | "cancelled" | "rejected";
  signature: Signature;
}

export type DvpCloseLookup =
  | ({ kind: "resolved" } & DvpCloseResolution)
  | { kind: "absent" }
  | { kind: "capped" };

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
 * `createSignature` bounds the history walk: SDP inserts the row before broadcasting create, and the PDA is only derivable
 * from the terms SDP publishes. Therefore no transaction concerning this trade
 * can precede `createdAt` by more than validator/API clock skew.
 */
export async function resolveDvpClose(
  rpc: SolanaRpc,
  swapDvp: Address,
  createSignature: Signature | null,
  createdAt: string
): Promise<DvpCloseLookup> {
  const createdAtFloor = Math.floor(Date.parse(createdAt) / 1000) - CREATE_TIME_SKEW_SECONDS;
  let before: Signature | undefined;
  for (let page = 0; page < HISTORY_PAGE_CAP; page += 1) {
    const history = await getSignaturesForAddress(rpc, swapDvp, {
      limit: HISTORY_PAGE_LIMIT,
      ...(before === undefined ? {} : { before }),
      ...(createSignature === null ? {} : { until: createSignature }),
    });
    for (const entry of history) {
      if (entry.signature === createSignature) {
        return { kind: "absent" };
      }
      if (entry.blockTime !== null && Number(entry.blockTime) < createdAtFloor) {
        return { kind: "absent" };
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
          return { kind: "resolved", status, signature: entry.signature };
        }
      }
    }
    if (history.length < HISTORY_PAGE_LIMIT) {
      return { kind: "absent" };
    }
    before = history[history.length - 1].signature;
  }
  return { kind: "capped" };
}
