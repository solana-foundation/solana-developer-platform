/**
 * Settlement shape for confidential operations.
 *
 * Configure, transfer and withdraw are executed as an ordered plan: proof
 * context-state setup → the operation itself → context-state cleanup. The
 * operation's effect lands in the LAST transaction, so that is the one whose
 * signature settles the ledger row; the rest are journaled alongside it so the
 * intermediate accounts stay traceable. The other four operations are a single
 * transaction and collapse to the same shape with one signature.
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
