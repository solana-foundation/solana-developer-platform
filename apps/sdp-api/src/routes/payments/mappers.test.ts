import { baseUnits } from "@sdp/solana/token-amount";
import { getAddressDecoder, unixTimestamp } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { PaymentTransferRow } from "@/db/repositories/payments.repository";
import type { TokenMovementLeg } from "@/db/repositories/token-movement-legs.repository";
import { mapTransferRow, mapTransferWithLegs } from "./mappers";

const SALE_REFERENCE = "826ca171-dd61-46e8-bfa1-8a22c7372f64";
const LEG_MINT = getAddressDecoder().decode(new Uint8Array(32).fill(7));

const wireObjectSchema = z.record(z.string(), z.unknown());

/** The transfer as the API sends it: JSON drops the fields a row doesn't have. */
function onTheWire(row: PaymentTransferRow): Record<string, unknown> {
  return wireObjectSchema.parse(JSON.parse(JSON.stringify(mapTransferRow(row))));
}

function offrampRow(overrides: Partial<PaymentTransferRow> = {}): PaymentTransferRow {
  return {
    id: "xfr_mapper_payout",
    organization_id: "org_mapper",
    project_id: "prj_mapper",
    custody_wallet_id: "cwlt_mapper",
    wallet_id: "wallet_mapper",
    counterparty_id: "cpty_mapper",
    source_address: "source",
    destination_address: "deposit",
    token: "USDC",
    amount: "25",
    memo: null,
    type: "offramp",
    kind: "offramp",
    direction: "outbound",
    status: "completed",
    provider: "moonpay",
    provider_reference: SALE_REFERENCE,
    provider_observed_at: "2026-10-19T23:06:32.066Z",
    delivery_mode: "hosted",
    fiat_currency: "USD",
    fiat_amount: "20.70",
    ramps_memo: {},
    provider_data: {
      providerSettlement: {
        reference: SALE_REFERENCE,
        observedAt: "2026-10-19T23:06:32.066Z",
        receivedAmount: "20.82",
        receivedCurrency: "USD",
      },
    },
    signature: "sig",
    serialized_tx: null,
    signed_transaction: "signed",
    last_valid_block_height: null,
    submission_started_at: "2026-10-19T23:05:00.000Z",
    slot: 512958400,
    block_time: null,
    fee: null,
    error: null,
    initiated_by_key_id: null,
    idempotency_key: null,
    idempotency_fingerprint: null,
    confirmed_at: "2026-10-19T23:07:00.000Z",
    finalization_last_polled_at: null,
    created_at: "2026-10-19T23:01:00.626Z",
    updated_at: "2026-10-19T23:07:00.000Z",
    ...overrides,
  };
}

describe("mapTransferRow payout and confirmation", () => {
  it("shows the provider's payout beside the quote and the confirmation time", () => {
    expect(mapTransferRow(offrampRow())).toMatchObject({
      fiatAmount: "20.70",
      fiatCurrency: "USD",
      fiatPayout: { amount: "20.82", currency: "USD", reportedAt: "2026-10-19T23:06:32.066Z" },
      confirmedAt: "2026-10-19T23:07:00.000Z",
    });
  });

  it("omits the payout when the settlement belongs to another provider transaction", () => {
    const row = offrampRow({ provider_reference: "a-later-sale" });
    expect(onTheWire(row)).not.toHaveProperty("fiatPayout");
  });

  it("omits the payout when the provider never named its currency", () => {
    const row = offrampRow({
      provider_data: {
        providerSettlement: { reference: SALE_REFERENCE, receivedAmount: "20.82" },
      },
    });
    expect(onTheWire(row)).not.toHaveProperty("fiatPayout");
  });

  it("never reads an on-ramp's delivered tokens as a fiat payout", () => {
    const row = offrampRow({ type: "onramp", kind: "onramp", direction: "inbound" });
    expect(onTheWire(row)).not.toHaveProperty("fiatPayout");
  });

  it("shows a delivery hold, and drops a hold the provider's next report cleared", () => {
    const hold = {
      reason: "amount_mismatch",
      checkedAt: "2026-10-19T23:30:00.000Z",
      reportedAmount: "20",
      observedAmount: "0.5",
    };
    const held = offrampRow({
      type: "onramp",
      kind: "onramp",
      direction: "inbound",
      status: "settling",
      confirmed_at: null,
      provider_data: { deliveryMismatch: hold },
    });
    expect(mapTransferRow(held)).toMatchObject({ deliveryMismatch: hold });
    expect(onTheWire({ ...held, provider_data: { deliveryMismatch: null } })).not.toHaveProperty(
      "deliveryMismatch"
    );
  });

  it("omits confirmedAt until the transfer is confirmed", () => {
    const row = offrampRow({ status: "settling", confirmed_at: null });
    expect(onTheWire(row)).not.toHaveProperty("confirmedAt");
  });
});

/** A verified 6-decimal token leg of `transferId`, with a credit basis. */
function creditLeg(
  transferId: string,
  quoted: { debit: bigint; fee: bigint; credit: bigint }
): TokenMovementLeg {
  const amounts = {
    debit: baseUnits(quoted.debit),
    fee: baseUnits(quoted.fee),
    credit: baseUnits(quoted.credit),
  };
  return {
    id: `tml_${transferId}`,
    organizationId: "org_mapper",
    projectId: "prj_mapper",
    owner: { kind: "transfer", transferId },
    asset: { kind: "token", mint: LEG_MINT, program: "spl-token" },
    decimals: 6,
    basis: "credit",
    quoted: amounts,
    feeEpoch: null,
    asOf: { slot: 512958400n, unixTimestamp: unixTimestamp(1760915192n) },
    displayRule: null,
    observed: amounts,
    verifiedBy: "chain",
    verification: { state: "verified", reason: "chain_delta_matched" },
    createdAt: "2026-10-19T23:07:00.000Z",
    updatedAt: "2026-10-19T23:07:00.000Z",
  };
}

describe("mapTransferWithLegs amount", () => {
  it("reports an on-ramp's delivered credit once its delivery has a leg, not the provider quote", () => {
    const row = offrampRow({ type: "onramp", kind: "onramp", direction: "inbound", amount: "25" });
    const leg = creditLeg(row.id, { debit: 25_500_000n, fee: 0n, credit: 25_500_000n });
    expect(mapTransferRow(row)).toMatchObject({ amount: "25" });
    expect(mapTransferWithLegs(row, [leg])).toMatchObject({
      amount: "25.5",
      amounts: { basis: "credit", debit: "25.5", fee: "0", credit: "25.5", decimals: 6 },
    });
  });

  it("keeps an off-ramp's provider deposit amount, its credit, beside a larger debit", () => {
    const row = offrampRow({ amount: "25" });
    const leg = creditLeg(row.id, { debit: 25_250_000n, fee: 250_000n, credit: 25_000_000n });
    expect(mapTransferWithLegs(row, [leg])).toMatchObject({
      amount: "25",
      amounts: { debit: "25.25", fee: "0.25", credit: "25" },
    });
  });
});
