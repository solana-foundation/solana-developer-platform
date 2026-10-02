/**
 * Settlement shape for confidential operations.
 *
 * An operation is executed as an ordered plan — proof context-state setup → the
 * operation itself → context-state cleanup — and settles on the LAST transaction
 * that confirmed. That is the right ledger evidence whatever the plan's shape:
 * the row's signature means "this is the last thing that landed for this
 * operation", and the rest are journaled alongside it so the intermediate
 * context-state accounts stay traceable.
 *
 * How many transactions there are is not fixed. At transaction version 0 an
 * operation needing proofs spans three or more, and the last one is the cleanup
 * rather than the operation itself. At version 1 the 4096-byte budget usually
 * folds the whole sequence into one or two, so `planSignatures` is frequently a
 * single entry — and then omitted entirely, per `planSignatureFields`.
 */

import type {
  MosaicTransactionPlanResult,
  MosaicTransactionResult,
} from "@sdp/issuance/mosaic/types";

export interface ConfidentialSettlement {
  signature: string;
  slot: bigint;
  /** Every signature in submission order. Only meaningful when longer than one. */
  planSignatures: string[];
}

/** One result per submitted transaction, in submission order. */
export function toSubmittedList(
  result: MosaicTransactionResult | MosaicTransactionPlanResult
): MosaicTransactionResult[] {
  return "transactions" in result ? result.transactions : [result];
}

/**
 * Reduce a submitted plan to its settlement evidence. Returns null when the plan
 * submitted nothing — a shape the planner should never produce, but which would
 * otherwise settle a row against `undefined`.
 */
export function summarizeConfidentialSettlement(
  result: MosaicTransactionResult | MosaicTransactionPlanResult
): ConfidentialSettlement | null {
  const submitted = toSubmittedList(result);
  const last = submitted[submitted.length - 1];
  if (!last) {
    return null;
  }
  return {
    signature: last.signature,
    slot: last.slot,
    planSignatures: submitted.map((entry) => entry.signature),
  };
}

/** Extra params/metadata for a settlement — omitted entirely for single-tx operations. */
export function planSignatureFields(
  settlement: ConfidentialSettlement
): { planSignatures: string[] } | Record<string, never> {
  return settlement.planSignatures.length > 1 ? { planSignatures: settlement.planSignatures } : {};
}
