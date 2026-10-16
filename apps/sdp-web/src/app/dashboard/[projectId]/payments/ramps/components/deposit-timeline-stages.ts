import type { PaymentTransferStatus } from "@sdp/types";

export type DepositStageState = "done" | "current" | "upcoming";

/**
 * Which stage of a funded deposit the transfer is at. There is no "funds sent" signal: while
 * the provider waits, sending is the current (the payer's) step; once the provider reports
 * settling it has the funds; completion means the wallet has them too.
 */
export function depositStageStates(status: PaymentTransferStatus | undefined): DepositStageState[] {
  switch (status) {
    case "settling":
    case "processing":
      return ["done", "done", "current"];
    case "completed":
    case "confirmed":
    case "finalized":
      return ["done", "done", "done"];
    default:
      return ["done", "current", "upcoming"];
  }
}
