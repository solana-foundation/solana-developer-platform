import {
  DVP_SWAP_PROGRAM_PROGRAM_ADDRESS,
  DvpSwapProgramInstruction,
  identifyDvpSwapProgramInstruction,
} from "@sdp/dvp";
import {
  getSignaturesForAddress,
  getTransaction,
  type ParsedInstruction,
  type SignatureInfo,
  type SolanaRpc,
} from "@sdp/rpc/solana";
import { type Address, getBase58Encoder, type Signature } from "@solana/kit";
import { mapSettledWithConcurrency } from "@/lib/concurrency";
import { internalError } from "@/lib/errors";

/** Position of `swap_dvp` in every SettleDvp, CancelDvp and RejectDvp account list. */
const SWAP_DVP_ACCOUNT_INDEX = 1;
const HISTORY_PAGE_LIMIT = 100;
const HISTORY_PAGE_CAP = 10;
/**
 * Page fetches of close transactions fan out with this bound, matching the
 * billed-RPC concurrency the observed-transfers read uses: a full page is up
 * to 100 round trips, and resolving them serially puts that cost between a
 * party and the answer to "what happened to my trade".
 */
export const TRANSACTION_LOOKUP_CONCURRENCY = 5;
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
 * Collects one history page's fetch candidates in history order, stopping at
 * the first bound — the create signature or an entry older than the created-at
 * floor — since nothing at or past a bound can concern this trade, so those
 * signatures are never fetched at all. The bound is reported rather than
 * thrown away: an earlier entry in the page may still carry the close, and it
 * wins over the bound.
 */
function collectCloseCandidates(
  history: SignatureInfo[],
  createSignature: Signature | null,
  createdAtFloor: number
): { candidates: SignatureInfo[]; boundHit: boolean } {
  const candidates: SignatureInfo[] = [];
  for (const entry of history) {
    if (
      entry.signature === createSignature ||
      (entry.blockTime !== null && Number(entry.blockTime) < createdAtFloor)
    ) {
      return { candidates, boundHit: true };
    }
    if (entry.err === null) {
      candidates.push(entry);
    }
  }
  return { candidates, boundHit: false };
}

/**
 * Fetches the candidates' transactions concurrently — bounded, because a page
 * holds up to 100 signatures against the billed RPC — and decodes the first
 * close in history order. Results stay aligned to that order, so this resolves
 * exactly the entry a serial walk would have reached first, and a rejected
 * fetch still throws unless an earlier entry already resolved the close.
 */
async function firstCloseOnPage(
  rpc: SolanaRpc,
  swapDvp: Address,
  candidates: SignatureInfo[]
): Promise<DvpCloseLookup | null> {
  const settled = await mapSettledWithConcurrency(
    candidates,
    TRANSACTION_LOOKUP_CONCURRENCY,
    (entry) => getTransaction(rpc, entry.signature)
  );
  for (const [index, entry] of candidates.entries()) {
    const lookup = settled[index];
    if (lookup === undefined) {
      continue;
    }
    if (lookup.status === "rejected") {
      throw lookup.reason;
    }
    const transaction = lookup.value;
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
  return null;
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
    const { candidates, boundHit } = collectCloseCandidates(
      history,
      createSignature,
      createdAtFloor
    );
    const close = await firstCloseOnPage(rpc, swapDvp, candidates);
    if (close !== null) {
      return close;
    }
    if (boundHit || history.length < HISTORY_PAGE_LIMIT) {
      return { kind: "absent" };
    }
    before = history[history.length - 1].signature;
  }
  return { kind: "capped" };
}
