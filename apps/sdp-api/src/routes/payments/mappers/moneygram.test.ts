import { describe, expect, it } from "vitest";
import type { PaymentTransferRow } from "@/db/repositories/payments.repository";
import { mapMoneygramTransferDetails } from "./moneygram";

function transferRow(overrides: Partial<PaymentTransferRow> = {}): PaymentTransferRow {
  return {
    id: "xfr_moneygram",
    organization_id: "org_test",
    project_id: "prj_test",
    wallet_id: "wal_test",
    counterparty_id: "counterparty_test",
    source_address: "8nb762111111111111111111111111111111hnis",
    destination_address: null,
    token: "USDC",
    amount: "25",
    memo: null,
    type: "offramp",
    direction: "outbound",
    status: "completed",
    provider: "moneygram",
    provider_reference: "mgi_session_example",
    delivery_mode: "session_widget",
    fiat_currency: "USD",
    fiat_amount: null,
    provider_data: {},
    signature: null,
    serialized_tx: null,
    slot: null,
    block_time: null,
    fee: null,
    error: null,
    initiated_by_key_id: null,
    created_at: "2026-06-22T10:17:00.000Z",
    updated_at: "2026-06-22T10:18:00.000Z",
    ...overrides,
  };
}

describe("mapMoneygramTransferDetails", () => {
  it("maps MoneyGram provider data into public transfer details", () => {
    const details = mapMoneygramTransferDetails(
      transferRow({
        provider_data: {
          moneygram: {
            payoutAmount: 25,
            payoutStatus: "completed",
            transactionId: "mgi_tx_example",
            referenceNumber: "12345678",
            cryptoTransferId: "xfr_moneygram_crypto_leg_example",
            solanaTxSignature: "sig_moneygram_usdc_transfer_example",
          },
        },
      })
    );

    expect(details).toEqual({
      payoutAmount: 25,
      payoutStatus: "completed",
      transactionId: "mgi_tx_example",
      referenceNumber: "12345678",
      cryptoTransferId: "xfr_moneygram_crypto_leg_example",
      solanaTxSignature: "sig_moneygram_usdc_transfer_example",
    });
  });

  it("does not expose MoneyGram details on non-MoneyGram transfers", () => {
    expect(
      mapMoneygramTransferDetails(
        transferRow({
          provider: "moonpay",
          provider_data: { moneygram: { referenceNumber: "12345678" } },
        })
      )
    ).toBeUndefined();
  });
});
