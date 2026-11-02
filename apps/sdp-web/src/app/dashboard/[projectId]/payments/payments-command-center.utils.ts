import {
  type PaymentTransferSummary,
  type PaymentTransferType,
  RAMP_TRANSFER_TYPES,
} from "@sdp/types/payments";
import type { MessageKey } from "@/i18n/messages";
import { resolveTransactionCounterpartyReference } from "./payments-overview.utils";

export function resolveCommandCenterCounterparty(transfer: PaymentTransferSummary): string {
  if (transfer.counterpartyDisplayName !== undefined) return transfer.counterpartyDisplayName;
  const reference = resolveTransactionCounterpartyReference(transfer);
  return reference === undefined ? "—" : reference;
}

/**
 * The transfer types the overview's activity list reads. Batches have their own list, so batch
 * parents stay out; ramp types only where the deployment runs Ramps, because the API refuses a
 * requested ramp type its release channel leaves out, and that 403 empties the whole list.
 *
 * @param rampsInReleaseChannel - Whether this deployment's release channel runs Ramps.
 * @returns Single transfers, plus onramps and offramps when Ramps runs.
 */
export function activityTransferTypes(
  rampsInReleaseChannel: boolean
): readonly PaymentTransferType[] {
  return rampsInReleaseChannel ? ["transfer", ...RAMP_TRANSFER_TYPES] : ["transfer"];
}

/** The modules a Pay or Deposit line can name, as this deployment's release channel runs them. */
export interface PaymentLineModules {
  ramps: boolean;
  compliance: boolean;
}

/**
 * The line under Pay, on the Payments overview and on Home. It names fiat only where the
 * channel runs Ramps and the screening only where it runs Compliance, so no page offers a
 * module the API refuses.
 *
 * @param modules - Whether the deployment's release channel runs Ramps and Compliance.
 * @returns The message key for the line.
 */
export function payLineKey({ ramps, compliance }: PaymentLineModules): MessageKey {
  if (ramps && compliance) return "DashboardPayments.newDesign.commandCenter.payDescription";
  if (ramps) return "DashboardPayments.newDesign.commandCenter.payDescriptionFiat";
  if (compliance) return "DashboardPayments.newDesign.commandCenter.payDescriptionChecked";
  return "DashboardPayments.newDesign.commandCenter.payDescriptionOnchain";
}

/**
 * The line under Deposit: a fiat ramp only where the channel runs Ramps.
 *
 * @param ramps - Whether the deployment's release channel runs Ramps.
 * @returns The message key for the line.
 */
export function depositLineKey(ramps: boolean): MessageKey {
  return ramps
    ? "DashboardPayments.newDesign.commandCenter.depositDescription"
    : "DashboardPayments.newDesign.commandCenter.depositDescriptionOnchain";
}
