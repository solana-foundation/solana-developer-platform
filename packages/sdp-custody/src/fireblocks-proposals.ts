import {
  isFireblocksSigningFinished,
  isFireblocksTransactionCancellable,
  isFireblocksTransactionCancelled,
  isFireblocksTransactionFailed,
} from "@sdp/types/fireblocks";
import type { ProposalObservation } from "#/proposals";

/** Fireblocks status vocabulary ends here; persistence uses the shared proposal state. */
export function fireblocksSigningObservation(input: {
  providerTransactionId: string;
  status: string;
  subStatus?: string;
  at: string;
}): ProposalObservation {
  let phase: ProposalObservation["phase"];
  if (isFireblocksTransactionCancelled(input.status)) phase = "cancelled";
  else if (isFireblocksTransactionFailed(input.status)) phase = "failed";
  else if (isFireblocksSigningFinished(input.status)) phase = "completed";
  else phase = isFireblocksTransactionCancellable(input.status) ? "pending" : "executing";
  return {
    type: "observed",
    at: input.at,
    phase,
    providerTransactionId: input.providerTransactionId,
    providerStatus: input.status,
    providerSubStatus: input.subStatus ?? null,
  };
}
