import { compareDecimalAmounts, decimalStringFromNumber } from "@sdp/payments/decimal";
import { type BvnkRampSettlement, bvnkRampSettlementSchema } from "@sdp/types";
import {
  type BvnkOnrampTransferData,
  isBvnkPayoutCompleted,
  isBvnkPayoutFailed,
} from "./provider-data";
import type { BvnkOnrampPayoutSummary } from "./schemas";

type BvnkOnrampPayin = NonNullable<BvnkOnrampTransferData["payin"]>;
type BvnkOnrampPayoutIntent = NonNullable<NonNullable<BvnkOnrampTransferData["payout"]>["intent"]>;

/** A payout observed in flight (create response or PROCESSING event): identity plus the requested fiat/crypto economics. */
export interface BvnkProcessingPayoutObservation {
  outcome: "processing";
  uuid: string;
  reference: string | null;
  type: string | null;
  walletId: string | null;
  cryptoCurrency: string;
  fiatCurrency: string;
  fiatDebit: string;
  destination: string | null;
  network: string | null;
}

/**
 * A FAILED/CANCELLED/EXPIRED observation carries its identity plus the
 * REQUESTED economics the summary/event reported: no money moved, so
 * identical replays compare on identity alone, but the requested fiat/crypto
 * economics are still validated against the intent for every summary
 * regardless of its status (P1-2).
 */
export interface BvnkFailedPayoutObservation {
  outcome: "failed";
  uuid: string;
  reference: string | null;
  type: string | null;
  walletId: string | null;
  cryptoCurrency: string | null;
  fiatCurrency: string | null;
  fiatDebit: string | null;
  destination: string | null;
  network: string | null;
}

/** A COMPLETE/COMPLETED observation carries the delivery facts and the full observed economics the comparator covers. */
export interface BvnkCompletedPayoutObservation {
  outcome: "completed";
  uuid: string;
  reference: string | null;
  type: string | null;
  walletId: string | null;
  hash: string;
  destination: string;
  network: string;
  cryptoAmount: string;
  cryptoCurrency: string;
  fiatDebit: string;
  fiatCurrency: string;
  fee: string;
  feeCurrency: string;
  networkFee: string;
  networkFeeCurrency: string;
  rate: string;
}

export type BvnkPayoutObservation =
  | BvnkProcessingPayoutObservation
  | BvnkFailedPayoutObservation
  | BvnkCompletedPayoutObservation;

/** The parse verdict for a payout observation source; a failed parse is never an observation. */
export type BvnkPayoutObservationParse =
  | { ok: true; observation: BvnkPayoutObservation }
  | { ok: false; reason: "completed-observation-incomplete" };

/** A money leg as parsed at the boundary: webhook codecs yield decimal strings, provider summary schemas yield numbers. */
export interface BvnkPayoutObservationMoney {
  amount: string | number;
  actual: string | number;
  currency: string;
}

/** The observable payout shape shared by the crypto payout webhook event and the provider payout summary. */
export interface BvnkPayoutObservationSource {
  uuid: string;
  reference: string | null;
  type: string;
  walletId: string;
  status: string;
  address?: { address: string; network: string } | null;
  transactions?: { hash: string }[];
  paidCurrency: BvnkPayoutObservationMoney;
  walletCurrency: BvnkPayoutObservationMoney;
  feeCurrency: BvnkPayoutObservationMoney;
  networkFeeCurrency: BvnkPayoutObservationMoney;
  exchangeRate: { rate: number };
}

function moneyString(value: string | number): string {
  return typeof value === "string" ? value : decimalStringFromNumber(value);
}

/** The address block of a source, or null when the source is unresolved about it. */
function sourceAddress(source: BvnkPayoutObservationSource): {
  address: string;
  network: string;
} | null {
  const address = source.address;
  return address === undefined || address === null ? null : address;
}

function buildObservation(source: BvnkPayoutObservationSource): BvnkPayoutObservationParse {
  const identity = {
    uuid: source.uuid,
    reference: source.reference,
    type: source.type,
    walletId: source.walletId,
  };
  if (isBvnkPayoutCompleted(source.status)) {
    const transaction = source.transactions?.[0];
    const address = sourceAddress(source);
    if (transaction === undefined || address === null) {
      return { ok: false, reason: "completed-observation-incomplete" };
    }
    return {
      ok: true,
      observation: {
        outcome: "completed",
        ...identity,
        hash: transaction.hash,
        destination: address.address,
        network: address.network,
        cryptoAmount: moneyString(source.paidCurrency.actual),
        cryptoCurrency: source.paidCurrency.currency,
        fiatDebit: moneyString(source.walletCurrency.actual),
        fiatCurrency: source.walletCurrency.currency,
        fee: moneyString(source.feeCurrency.actual),
        feeCurrency: source.feeCurrency.currency,
        networkFee: moneyString(source.networkFeeCurrency.actual),
        networkFeeCurrency: source.networkFeeCurrency.currency,
        rate: decimalStringFromNumber(source.exchangeRate.rate),
      },
    };
  }
  const address = sourceAddress(source);
  if (isBvnkPayoutFailed(source.status)) {
    return {
      ok: true,
      observation: {
        outcome: "failed",
        ...identity,
        cryptoCurrency: source.paidCurrency.currency,
        fiatCurrency: source.walletCurrency.currency,
        fiatDebit: moneyString(source.walletCurrency.amount),
        destination: address === null ? null : address.address,
        network: address === null ? null : address.network,
      },
    };
  }
  return {
    ok: true,
    observation: {
      outcome: "processing",
      ...identity,
      cryptoCurrency: source.paidCurrency.currency,
      fiatCurrency: source.walletCurrency.currency,
      fiatDebit: moneyString(source.walletCurrency.amount),
      destination: address === null ? null : address.address,
      network: address === null ? null : address.network,
    },
  };
}

/**
 * Builds the payout observation from a webhook event or provider payout
 * summary (create, uuid read, or list row). A COMPLETE observation missing
 * its delivery facts cannot be an observation at all and reads as a failed
 * parse; the API layer translates that into its error type.
 */
export function bvnkPayoutObservationFromSource(
  source: BvnkPayoutObservationSource
): BvnkPayoutObservationParse {
  return buildObservation(source);
}

function observationAmountsEqual(left: string | null, right: string | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return compareDecimalAmounts(left, right) === 0;
}

/**
 * Whether two observations of one payout are an identical terminal replay.
 * Failed observations compare on identity alone (no money moved); completed
 * observations compare every delivery fact and the full observed economics
 * incl. fee legs, currencies, and the rate, so a fee/rate-only divergence is
 * a conflict that must be retained, never acknowledged.
 */
export function bvnkTerminalObservationsEqual(
  left: BvnkPayoutObservation,
  right: BvnkPayoutObservation
): boolean {
  const identityEqual =
    left.uuid === right.uuid &&
    left.reference === right.reference &&
    left.type === right.type &&
    left.walletId === right.walletId;
  if (left.outcome === "failed" && right.outcome === "failed") {
    return identityEqual;
  }
  if (left.outcome !== "completed" || right.outcome !== "completed") {
    return false;
  }
  return (
    identityEqual &&
    left.hash === right.hash &&
    left.destination === right.destination &&
    left.network === right.network &&
    observationAmountsEqual(left.cryptoAmount, right.cryptoAmount) &&
    left.cryptoCurrency === right.cryptoCurrency &&
    observationAmountsEqual(left.fiatDebit, right.fiatDebit) &&
    left.fiatCurrency === right.fiatCurrency &&
    observationAmountsEqual(left.fee, right.fee) &&
    left.feeCurrency === right.feeCurrency &&
    observationAmountsEqual(left.networkFee, right.networkFee) &&
    left.networkFeeCurrency === right.networkFeeCurrency &&
    observationAmountsEqual(left.rate, right.rate)
  );
}

/**
 * Validates an observation against the persisted pay-in ownership facts and
 * the claimed spend intent: same reference and transfer, type OUT, the pay-in
 * wallet, and the requested fiat amount and currency, asset, destination, and
 * network. The requested economics are validated for EVERY summary regardless
 * of its status, FAILED included, so a create/adopt candidate with an
 * unresolved destination or network never passes identity — it is ambiguous,
 * left claimed, logged, and never recorded (P1-2). A signature proves origin,
 * not consistency.
 *
 * @returns The mismatched field names; empty when the observation is consistent.
 */
export function bvnkPayoutObservationMismatches(
  observation: BvnkPayoutObservation,
  transferId: string,
  payin: BvnkOnrampPayin,
  intent: BvnkOnrampPayoutIntent
): string[] {
  const mismatches: string[] = [];
  if (observation.reference !== null && observation.reference !== transferId) {
    mismatches.push("reference");
  }
  if (observation.type !== null && observation.type !== "OUT") {
    mismatches.push("type");
  }
  if (observation.walletId !== null && observation.walletId !== payin.walletId) {
    mismatches.push("wallet");
  }
  if (observation.cryptoCurrency !== null && observation.cryptoCurrency !== intent.cryptoCurrency) {
    mismatches.push("crypto currency");
  }
  if (observation.fiatCurrency !== null && observation.fiatCurrency !== intent.currency) {
    mismatches.push("fiat currency");
  }
  if (
    observation.fiatDebit !== null &&
    compareDecimalAmounts(observation.fiatDebit, intent.amount) !== 0
  ) {
    mismatches.push("amount");
  }
  if (observation.destination !== null && observation.destination !== intent.address) {
    mismatches.push("destination");
  }
  if (observation.network !== null && observation.network !== intent.network) {
    mismatches.push("network");
  }
  return mismatches;
}

/** Builds the PROCESSING settlement blob from a payout create/adopt summary; the receipt url is caller-validated. */
export function buildProcessingSettlement(
  payinId: string,
  summary: BvnkOnrampPayoutSummary,
  receiptUrl: string
): BvnkRampSettlement {
  return {
    provider: "bvnk",
    status: "PROCESSING",
    payinId,
    payoutId: summary.uuid,
    receiptUrl,
    fiatCurrency: summary.walletCurrency.currency,
    fiatAmount: decimalStringFromNumber(summary.walletCurrency.amount),
    cryptoCurrency: summary.paidCurrency.currency,
    cryptoAmount: decimalStringFromNumber(summary.paidCurrency.amount),
    feeCurrency: summary.feeCurrency.currency,
    feeAmount: decimalStringFromNumber(summary.feeCurrency.amount),
    networkFeeCurrency: summary.networkFeeCurrency.currency,
    networkFeeAmount: decimalStringFromNumber(summary.networkFeeCurrency.amount),
    exchangeRate: decimalStringFromNumber(summary.exchangeRate.rate),
  };
}

/** Builds the COMPLETE settlement blob: create-time estimates preserved for display, observed terminal facts added separately. */
export function buildCompleteSettlement(
  storedSettlement: BvnkRampSettlement,
  observation: BvnkCompletedPayoutObservation
): BvnkRampSettlement {
  return {
    ...storedSettlement,
    status: "COMPLETE",
    txHash: observation.hash,
    cryptoAmountActual: observation.cryptoAmount,
    fiatAmountActual: observation.fiatDebit,
    feeAmountActual: observation.fee,
    feeCurrencyActual: observation.feeCurrency,
    networkFeeAmountActual: observation.networkFee,
    networkFeeCurrencyActual: observation.networkFeeCurrency,
    exchangeRateActual: observation.rate,
  };
}

/** The stored settlement read verdict: absent key, a valid blob, or a malformed blob. */
export type StoredBvnkSettlementRead =
  | { outcome: "absent" }
  | { outcome: "present"; settlement: BvnkRampSettlement }
  | { outcome: "malformed" };

/**
 * Reads the stored settlement blob strictly. A malformed blob reads as
 * `"malformed"` — never as absent — so the API layer can fail loudly instead
 * of treating corrupt economics as missing.
 */
export function readStoredBvnkSettlement(providerData: {
  settlement?: unknown;
}): StoredBvnkSettlementRead {
  if (!("settlement" in providerData)) {
    return { outcome: "absent" };
  }
  const parsed = bvnkRampSettlementSchema.safeParse(providerData.settlement);
  if (!parsed.success) {
    return { outcome: "malformed" };
  }
  return { outcome: "present", settlement: parsed.data };
}
