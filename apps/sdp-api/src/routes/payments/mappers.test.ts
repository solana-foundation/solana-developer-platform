import { createNoopSigner, type Instruction } from "@solana/kit";
import {
  getTransferCheckedInstruction,
  getTransferCheckedWithFeeInstruction,
} from "@solana-program/token-2022";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { PaymentTransferRow } from "@/db/repositories/payments.repository";
import { syntheticAddress, syntheticWireTransaction } from "@/test/helpers/parsed-transactions";
import { mapTransferRow } from "./mappers";

const SALE_REFERENCE = "826ca171-dd61-46e8-bfa1-8a22c7372f64";

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
    signed_transaction: null,
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

describe("mapTransferRow Token-2022 amounts from the signed transfer", () => {
  const authority = createNoopSigner(syntheticAddress(2));
  const transferAccounts = {
    source: syntheticAddress(3),
    mint: syntheticAddress(1),
    destination: syntheticAddress(4),
    authority,
    decimals: 6,
  };

  function signedTransferRow(signedTransfer: Instruction): PaymentTransferRow {
    return offrampRow({
      type: "transfer",
      kind: "pay",
      signed_transaction: syntheticWireTransaction(authority.address, [signedTransfer]),
    });
  }

  const transferWire = {
    id: "xfr_mapper_payout",
    organizationId: "org_mapper",
    custodyWalletId: "cwlt_mapper",
    providerWalletId: "wallet_mapper",
    projectId: "prj_mapper",
    type: "transfer",
    kind: "pay",
    direction: "outbound",
    status: "completed",
    signature: "sig",
    serializedTx: null,
    slot: 512958400,
    blockTime: null,
    confirmedAt: "2026-10-19T23:07:00.000Z",
    fee: null,
    error: null,
    source: "source",
    destination: "deposit",
    counterpartyId: "cpty_mapper",
    rampsMemo: {},
    token: "USDC",
    amount: "25",
    createdAt: "2026-10-19T23:01:00.626Z",
    updatedAt: "2026-10-19T23:07:00.000Z",
  };

  it("states the fee the transfer withheld and what the recipient received", () => {
    const withFee = getTransferCheckedWithFeeInstruction({
      ...transferAccounts,
      amount: 25_000_000n,
      fee: 2_500n,
    });

    expect(onTheWire(signedTransferRow(withFee))).toEqual({
      ...transferWire,
      transferFee: "0.0025",
      receivedAmount: "24.9975",
    });
  });

  it("states the underlying amount a scaled mint moved", () => {
    const scaled = getTransferCheckedInstruction({ ...transferAccounts, amount: 12_500_000n });

    expect(onTheWire(signedTransferRow(scaled))).toEqual({
      ...transferWire,
      unscaledAmount: "12.5",
    });
  });
});
