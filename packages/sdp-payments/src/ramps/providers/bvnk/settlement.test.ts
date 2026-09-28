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
import {
  BVNK_CHANNEL_TRANSACTION_CONFIRMED_WEBHOOK,
  BVNK_OFFRAMP_CHANNEL_SETTLEMENT_EXPECTED,
} from "./test-fixtures";

function completedObservation(
  overrides: Partial<BvnkCompletedPayoutObservation>
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
function failedObservation(
  overrides: Partial<BvnkFailedPayoutObservation>
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
    const ours = completedObservation({});
    const competitors = completedObservation({ fee: "9.9" });
    assert.equal(bvnkTerminalObservationsEqual(ours, competitors), false);
    assert.equal(bvnkTerminalObservationsEqual(competitors, ours), false);
  });
  it("identical_terminal_replays_are_acknowledged", () => {
    const completed = completedObservation({});
    assert.equal(bvnkTerminalObservationsEqual(completed, { ...completed }), true);
    const failed = failedObservation({});
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
    const base = completedObservation({});
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
    const base = completedObservation({});
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
        completedObservation({}),
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
  function parsedConfirmedPayload(): BvnkChannelTransactionConfirmedData {
    const data = BVNK_CHANNEL_TRANSACTION_CONFIRMED_WEBHOOK.data;
    const exchangeRate = data.exchangeRate as { rate: number };
    const networkFee = data.networkFee as { paidCurrency: string; paidAmount: number };
    return {
      channelId: data.channelId,
      uuid: data.uuid,
      hash: data.hash,
      address: data.address,
      paidCurrency: data.paidCurrency,
      paidAmount: String(data.paidAmount),
      displayCurrency: data.displayCurrency,
      displayAmount: String(data.displayAmount),
      walletCurrency: data.walletCurrency,
      walletAmount: String(data.walletAmount),
      feeCurrency: data.feeCurrency,
      feeAmount: String(data.feeAmount),
      exchangeRate: { rate: String(exchangeRate.rate) },
      networkFee: {
        paidCurrency: networkFee.paidCurrency,
        paidAmount: String(networkFee.paidAmount),
      },
      sources: [...data.sources],
    };
  }
  it("maps_the_observed_confirmed_payload_to_the_settlement_object_exactly", () => {
    const parsed = parsedConfirmedPayload();
    assert.deepEqual(
      bvnkOfframpChannelSettlementFromEvent(parsed),
      BVNK_OFFRAMP_CHANNEL_SETTLEMENT_EXPECTED
    );
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
