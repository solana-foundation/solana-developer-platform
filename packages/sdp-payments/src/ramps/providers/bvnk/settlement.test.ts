import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  BvnkChannelTransactionConfirmedData,
  BvnkCompletedPayoutObservation,
  BvnkFailedPayoutObservation,
} from "./settlement";
import {
  bvnkOfframpChannelSettlementFromEvent,
  bvnkPayoutObservationMismatches,
  bvnkTerminalObservationsEqual,
} from "./settlement";
import { BVNK_CHANNEL_TRANSACTION_CONFIRMED_WEBHOOK } from "./test-fixtures";

/** One canonical completed observation; every field is caller-written. */
function completedObservation(
  overrides: Partial<BvnkCompletedPayoutObservation> = {}
): BvnkCompletedPayoutObservation {
  return {
    outcome: "completed",
    uuid: "payout_1",
    reference: "xfr_1",
    type: "OUT",
    walletId: "a:1:wallet:1",
    hash: "tx_same",
    destination: "AddrSame",
    network: "SOLANA",
    cryptoAmount: "99.8",
    cryptoCurrency: "USDC",
    fiatDebit: "99.8",
    fiatCurrency: "USD",
    fee: "0.2",
    feeCurrency: "USD",
    networkFee: "0",
    networkFeeCurrency: "USD",
    rate: "0.998",
    ...overrides,
  };
}

/** One canonical failed observation; failed replays compare on identity alone. */
function failedObservation(
  overrides: Partial<BvnkFailedPayoutObservation> = {}
): BvnkFailedPayoutObservation {
  return {
    outcome: "failed",
    uuid: "payout_failed_1",
    reference: "xfr_1",
    type: "OUT",
    walletId: "a:1:wallet:1",
    cryptoCurrency: "USDC",
    fiatCurrency: "USD",
    fiatDebit: "99.8",
    destination: "AddrSame",
    network: "SOLANA",
    ...overrides,
  };
}

describe("bvnkTerminalObservationsEqual", () => {
  it("terminal_conflict_is_retained_when_a_competitor_wins", () => {
    // A competing terminal write with DIVERGED delivery facts is a conflict,
    // never an identical replay: same identity, different observed fee.
    const ours = completedObservation();
    const competitors = completedObservation({ fee: "9.9" });
    assert.equal(bvnkTerminalObservationsEqual(ours, competitors), false);
    assert.equal(bvnkTerminalObservationsEqual(competitors, ours), false);
  });

  it("identical_terminal_replays_are_acknowledged", () => {
    const completed = completedObservation();
    assert.equal(bvnkTerminalObservationsEqual(completed, { ...completed }), true);
    // Failed observations replay on identity alone: no money moved, so the
    // requested economics never conflict.
    const failed = failedObservation();
    assert.equal(
      bvnkTerminalObservationsEqual(failed, {
        ...failed,
        fiatDebit: "1.00",
        destination: "AddrOther",
      }),
      true
    );
  });

  it("varies_every_completed_delivery_fact_independently", () => {
    const base = completedObservation();
    const variants: Partial<BvnkCompletedPayoutObservation>[] = [
      { hash: "tx_other" },
      { destination: "AddrOther" },
      { network: "SOL" },
      { cryptoAmount: "99.7" },
      { cryptoCurrency: "SOL" },
      { fiatDebit: "99.7" },
      { fiatCurrency: "EUR" },
      { fee: "0.3" },
      { feeCurrency: "EUR" },
      { networkFee: "0.1" },
      { networkFeeCurrency: "EUR" },
      { rate: "0.999" },
      { uuid: "payout_other" },
      { reference: "xfr_other" },
      { type: "IN" },
      { walletId: "a:1:wallet:other" },
    ];
    for (const variant of variants) {
      assert.equal(bvnkTerminalObservationsEqual(base, { ...base, ...variant }), false);
    }
  });

  it("accepts_numerically_equal_decimal_strings_as_identical", () => {
    const base = completedObservation();
    assert.equal(
      bvnkTerminalObservationsEqual(base, {
        ...base,
        cryptoAmount: "99.80",
        fiatDebit: "99.80",
        fee: "0.20",
        networkFee: "0.00",
        rate: "0.9980",
      }),
      true
    );
  });

  it("never_confuses_completed_with_failed_observations", () => {
    assert.equal(
      bvnkTerminalObservationsEqual(
        completedObservation(),
        failedObservation({
          uuid: "payout_1",
          reference: "xfr_1",
          type: "OUT",
          walletId: "a:1:wallet:1",
        })
      ),
      false
    );
  });
});

describe("bvnkOfframpChannelSettlementFromEvent", () => {
  /** The observed confirmed payload's data with every money field as a decimal string. */
  function parsedConfirmedPayload(): BvnkChannelTransactionConfirmedData {
    const data: Record<string, unknown> = BVNK_CHANNEL_TRANSACTION_CONFIRMED_WEBHOOK.data;
    const exchangeRate = data.exchangeRate as { rate: number };
    const networkFee = data.networkFee as { paidCurrency: string; paidAmount: number };
    return {
      channelId: data.channelId as string,
      uuid: data.uuid as string,
      hash: data.hash as string,
      address: data.address as string,
      paidCurrency: data.paidCurrency as string,
      paidAmount: String(data.paidAmount),
      displayCurrency: data.displayCurrency as string,
      displayAmount: String(data.displayAmount),
      walletCurrency: data.walletCurrency as string,
      walletAmount: String(data.walletAmount),
      feeCurrency: data.feeCurrency as string,
      feeAmount: String(data.feeAmount),
      exchangeRate: { rate: String(exchangeRate.rate) },
      networkFee: {
        paidCurrency: networkFee.paidCurrency,
        paidAmount: String(networkFee.paidAmount),
      },
      sources: data.sources as string[],
    };
  }

  it("maps_the_observed_confirmed_payload_to_the_settlement_object_exactly", () => {
    const parsed = parsedConfirmedPayload();

    assert.deepEqual(bvnkOfframpChannelSettlementFromEvent(parsed), {
      provider: "bvnk",
      kind: "offramp_channel",
      status: "COMPLETE",
      channelId: parsed.channelId,
      transactionId: parsed.uuid,
      txHash: parsed.hash,
      depositAddress: parsed.address,
      cryptoCurrency: parsed.paidCurrency,
      cryptoAmount: parsed.paidAmount,
      fiatCurrency: parsed.walletCurrency,
      fiatAmount: parsed.walletAmount,
      displayCurrency: parsed.displayCurrency,
      displayAmount: parsed.displayAmount,
      feeCurrency: parsed.feeCurrency,
      feeAmount: parsed.feeAmount,
      networkFeeCurrency: parsed.networkFee.paidCurrency,
      networkFeeAmount: parsed.networkFee.paidAmount,
      exchangeRate: parsed.exchangeRate.rate,
      sources: parsed.sources,
    });
  });

  it("records_the_observed_confirmed_economics_as_decimal_strings", () => {
    const parsed = parsedConfirmedPayload();
    const settlement = bvnkOfframpChannelSettlementFromEvent(parsed);

    assert.equal(settlement.cryptoAmount, "10");
    assert.equal(settlement.fiatAmount, "9.9");
    assert.equal(settlement.feeAmount, "0.09");
    assert.equal(settlement.exchangeRate, "0.99");
    assert.equal(settlement.networkFeeCurrency, "SOL");
    assert.equal(settlement.networkFeeAmount, "0.00001");
  });
});

describe("bvnkPayoutObservationMismatches", () => {
  const payin = {
    id: "payin_1",
    receivedAmount: "100",
    receivedCurrency: "USD",
    walletId: "a:1:wallet:1",
    customerId: "cust_1",
  };
  const intent = {
    amount: "99.8",
    currency: "USD",
    cryptoCurrency: "USDC",
    network: "SOLANA",
    address: "AddrSame",
  };

  it("failed_payout_without_a_destination_matches_its_intent", () => {
    const observation = failedObservation({ destination: null, network: null });
    assert.deepEqual(bvnkPayoutObservationMismatches(observation, "xfr_1", payin, intent), []);
  });

  it("completed_payout_to_another_destination_mismatches", () => {
    const observation = completedObservation({ destination: "AddrOther" });
    assert.deepEqual(bvnkPayoutObservationMismatches(observation, "xfr_1", payin, intent), [
      "destination",
    ]);
  });
});
