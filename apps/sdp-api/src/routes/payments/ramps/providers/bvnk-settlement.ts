import {
  isValidBvnkReceiptUrl,
  readBvnkOnrampTransferData,
} from "@sdp/payments/ramps/providers/bvnk/provider-data";
import type { BvnkOnrampPayoutSummary } from "@sdp/payments/ramps/providers/bvnk/schemas";
import {
  type BvnkPayoutObservation,
  buildCompleteSettlement,
  buildProcessingSettlement,
  bvnkPayoutObservationFromSource,
  bvnkPayoutObservationMismatches,
  bvnkTerminalObservationsEqual,
  readStoredBvnkSettlement,
} from "@sdp/payments/ramps/providers/bvnk/settlement";
import type { SdpEnvironment } from "@sdp/types";
import type { BvnkOnrampTransfersRepository } from "@/db/repositories/bvnk-onramp-transfers.repository";
import type { PaymentTransferRow } from "@/db/repositories/payments.repository";
import { internalError } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";

export interface RecordBvnkPayoutCreationInput {
  repo: BvnkOnrampTransfersRepository;
  environment: SdpEnvironment;
  transfer: PaymentTransferRow;
  claimedAt: string;
  summary: BvnkOnrampPayoutSummary;
}

export interface ApplyTerminalBvnkPayoutObservationInput {
  repo: BvnkOnrampTransfersRepository;
  environment: SdpEnvironment;
  transfer: PaymentTransferRow;
  observation: BvnkPayoutObservation;
  failError: string;
  terminalError: (message: string) => Error;
}

/**
 * Records a payout the reconciler created or adopted: the receipt url is
 * validated against the project environment, the summary is checked against
 * the stored pay-in and claim intent, then the payout id and the PROCESSING
 * settlement land in ONE first-write-wins UPDATE.
 *
 * @param input - Repository, environment, current transfer row, held claim timestamp, and the provider summary.
 * @throws internalError when the summary or receipt url conflicts with the stored intent.
 */
export async function recordBvnkPayoutCreation(
  input: RecordBvnkPayoutCreationInput
): Promise<void> {
  const data = readBvnkOnrampTransferData(input.transfer.provider_data);
  const payin = data.payin;
  const payout = data.payout;
  const intent = payout === undefined ? undefined : payout.intent;
  if (payin === undefined || intent === undefined) {
    throw internalError(
      `BVNK on-ramp payout for ${input.transfer.id} has no stored pay-in or claim intent`
    );
  }
  const receiptUrl = input.summary.redirectUrl;
  if (receiptUrl === undefined) {
    throw internalError(
      `BVNK payout create response for ${input.transfer.id} lacks the receipt url.`
    );
  }
  if (!isValidBvnkReceiptUrl(receiptUrl, input.environment, input.summary.uuid)) {
    throw internalError(
      `BVNK payout create response for ${input.transfer.id} carries an untrusted receipt url.`
    );
  }
  const parsed = bvnkPayoutObservationFromSource(input.summary);
  if (!parsed.ok) {
    throw internalError(
      `BVNK payout create response for ${input.transfer.id} lacks the transaction hash or destination address.`
    );
  }
  const mismatches = bvnkPayoutObservationMismatches(
    parsed.observation,
    input.transfer.id,
    payin,
    intent
  );
  if (mismatches.length > 0) {
    throw internalError(
      `BVNK payout create response conflicts with the stored intent (${mismatches.join(", ")}) for ${input.transfer.id}.`
    );
  }
  await input.repo.recordPayoutId({
    transferId: input.transfer.id,
    payoutId: input.summary.uuid,
    claimedAt: input.claimedAt,
    environment: input.environment,
    settlement: buildProcessingSettlement(payin.id, input.summary, receiptUrl),
  });
}

/**
 * Applies one terminal payout observation — the shared settle/fail operation
 * behind the webhook COMPLETE/FAILED paths and the poll path. The observation
 * must match the stored payout id and the persisted pay-in/intent; the
 * repository CAS decides the race. A lost CAS re-reads the row and accepts an
 * identical terminal observation as a replay; anything else is converted
 * through the caller's error translation (TerminalRampWebhookError for
 * webhooks, internalError for polls).
 *
 * @param input - Repository, environment, transfer row, observation, the failed status to store, and the error translation.
 */
export async function applyTerminalBvnkPayoutObservation(
  input: ApplyTerminalBvnkPayoutObservationInput
): Promise<void> {
  const data = readBvnkOnrampTransferData(input.transfer.provider_data);
  const payin = data.payin;
  const payout = data.payout;
  const intent = payout === undefined ? undefined : payout.intent;
  if (payin === undefined || payout === undefined || intent === undefined) {
    throw internalError(
      `BVNK on-ramp transfer ${input.transfer.id} has no stored pay-in, claim, or intent`
    );
  }
  if (payout.payoutId === undefined) {
    throw internalError(
      "BVNK payout webhook arrived before the payout id was recorded; the inbox replay will retry"
    );
  }
  if (payout.payoutId !== input.observation.uuid) {
    throw input.terminalError("stray payout: payout id mismatch");
  }
  const mismatches = bvnkPayoutObservationMismatches(
    input.observation,
    input.transfer.id,
    payin,
    intent
  );
  if (mismatches.length > 0) {
    throw input.terminalError(
      `stray payout: observation conflicts with the stored intent (${mismatches.join(", ")})`
    );
  }
  let applied: PaymentTransferRow | null;
  if (input.observation.outcome === "completed") {
    const storedSettlement = readStoredBvnkSettlement(input.transfer.provider_data);
    if (storedSettlement.outcome === "malformed") {
      throw internalError(
        `BVNK on-ramp transfer ${input.transfer.id} has a malformed stored settlement.`
      );
    }
    if (storedSettlement.outcome === "absent") {
      throw internalError(
        `BVNK on-ramp transfer ${input.transfer.id} has no stored settlement to complete`
      );
    }
    const settlement = buildCompleteSettlement(storedSettlement.settlement, input.observation);
    applied = await input.repo.settlePayout({
      transferId: input.transfer.id,
      payoutId: input.observation.uuid,
      claimedAt: payout.claimedAt,
      update: {
        signature: input.observation.hash,
        destinationAddress: input.observation.destination,
        amount: input.observation.cryptoAmount,
        settlement: { ...settlement },
      },
    });
  } else if (input.observation.outcome === "failed") {
    applied = await input.repo.failPayout({
      transferId: input.transfer.id,
      payoutId: input.observation.uuid,
      error: input.failError,
      claimedAt: payout.claimedAt,
    });
  } else {
    throw internalError(
      `BVNK on-ramp transfer ${input.transfer.id} reached the terminal operation while processing`
    );
  }
  if (applied !== null) {
    getLogger().info(
      { transfer_id: input.transfer.id, payout_id: input.observation.uuid },
      "[bvnk settlement] terminal observation applied"
    );
    return;
  }
  const stored = await storedBvnkTerminalObservation(
    input.repo,
    input.transfer.id,
    input.environment
  );
  if (stored === null) {
    throw input.terminalError("stray payout: transfer vanished");
  }
  if (!bvnkTerminalObservationsEqual(stored, input.observation)) {
    throw input.terminalError("stray payout: conflicting payout observation");
  }
  getLogger().info(
    { transfer_id: input.transfer.id, payout_id: input.observation.uuid },
    "[bvnk settlement] identical terminal replay acknowledged"
  );
}

/**
 * Reconstructs the canonical terminal observation a re-read row holds, for
 * the lost-CAS replay check: a failed row yields its failed identity (the
 * stored payout id, transfer reference, OUT type, and pay-in wallet), a
 * completed row the delivery facts and the observed economics from the
 * COMPLETE settlement blob. A row that is neither terminal nor this transfer
 * reads null.
 *
 * @param repo - The BVNK on-ramp transfers repository for the re-read.
 * @param transferId - The transfer whose terminal CAS was lost.
 * @param environment - The project environment of the transfer.
 * @returns The stored terminal observation, or null when the row is not terminal.
 */
async function storedBvnkTerminalObservation(
  repo: BvnkOnrampTransfersRepository,
  transferId: string,
  environment: SdpEnvironment
): Promise<BvnkPayoutObservation | null> {
  const row = await repo.getById({ transferId, environment });
  if (row === null) {
    return null;
  }
  const data = readBvnkOnrampTransferData(row.provider_data);
  const payin = data.payin;
  const payout = data.payout;
  const intent = payout === undefined ? undefined : payout.intent;
  if (
    payin === undefined ||
    payout === undefined ||
    payout.payoutId === undefined ||
    intent === undefined
  ) {
    return null;
  }
  const identity = {
    uuid: payout.payoutId,
    reference: row.id,
    type: "OUT",
    walletId: payin.walletId,
  };
  if (row.status === "failed") {
    // The stored failed row reconstructs its identity only; the requested
    // economics were validated when the payout was recorded, and the terminal
    // replay compare is identity-only for failed observations.
    return {
      outcome: "failed",
      ...identity,
      cryptoCurrency: null,
      fiatCurrency: null,
      fiatDebit: null,
      destination: null,
      network: null,
    };
  }
  if (
    row.status !== "completed" ||
    row.signature === null ||
    row.destination_address === null ||
    row.amount === null
  ) {
    return null;
  }
  const settlement = readStoredBvnkSettlement(row.provider_data);
  switch (settlement.outcome) {
    case "malformed":
      throw internalError(`BVNK on-ramp transfer ${transferId} has a malformed stored settlement.`);
    case "absent":
      return null;
    case "present":
      break;
  }
  if (settlement.settlement.status !== "COMPLETE") {
    return null;
  }
  return {
    outcome: "completed",
    ...identity,
    hash: row.signature,
    destination: row.destination_address,
    network: intent.network,
    cryptoAmount: row.amount,
    cryptoCurrency: settlement.settlement.cryptoCurrency,
    fiatDebit: settlement.settlement.fiatAmountActual,
    fiatCurrency: settlement.settlement.fiatCurrency,
    fee: settlement.settlement.feeAmountActual,
    feeCurrency: settlement.settlement.feeCurrencyActual,
    networkFee: settlement.settlement.networkFeeAmountActual,
    networkFeeCurrency: settlement.settlement.networkFeeCurrencyActual,
    rate: settlement.settlement.exchangeRateActual,
  };
}
