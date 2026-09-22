import { describe, expect, it } from "vitest";
import type { PaymentTransferRow } from "@/db/repositories/payments.repository";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { mapMoneygramTransferDetails } from "./moneygram";

function transferRow(overrides: Partial<PaymentTransferRow>): PaymentTransferRow {
  return {
    id: "xfr_moneygram",
    organization_id: "org_test",
    project_id: "prj_test",
    custody_wallet_id: null,
    wallet_id: "wal_test",
    counterparty_id: "cpty_test",
    source_address: TEST_SOLANA_ADDRESSES.wallet1,
    destination_address: null,
    token: "USDC",
    amount: "25",
    memo: null,
    type: "offramp",
    kind: "offramp",
    direction: "outbound",
    status: "completed",
    provider: "moneygram",
    provider_reference: "mgi_session_example",
    delivery_mode: "session_widget",
    fiat_currency: "USD",
    fiat_amount: null,
    ramps_memo: {},
    provider_data: {},
    signature: null,
    serialized_tx: null,
    signed_transaction: null,
    last_valid_block_height: null,
    submission_started_at: null,
    slot: null,
    block_time: null,
    confirmed_at: null,
    finalization_last_polled_at: null,
    fee: null,
    error: null,
    initiated_by_key_id: null,
    idempotency_key: null,
    idempotency_fingerprint: null,
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
  it("projects the custodial customer, transaction and deposit fields", () => {
    expect(
      mapMoneygramTransferDetails(
        transferRow({
          provider_data: {
            moneygram: {
              customerId: "mg_profile_1",
              mgiTransactionId: "mgi_tx_created_1",
              depositAddress: TEST_SOLANA_ADDRESSES.wallet2,
              depositMemo: "mg_memo_1",
              sendAmount: "25",
            },
          },
        })
      )
    ).toEqual({
      customerId: "mg_profile_1",
      mgiTransactionId: "mgi_tx_created_1",
      depositAddress: TEST_SOLANA_ADDRESSES.wallet2,
      depositMemo: "mg_memo_1",
      sendAmount: "25",
    });
  });

  it.each(["", "   "])("drops blank custodial fields (%j)", (value) => {
    expect(
      mapMoneygramTransferDetails(
        transferRow({
          provider_data: {
            moneygram: {
              transactionId: "mg_tx_created_1",
              mgiTransactionId: value,
              depositAddress: value,
              depositMemo: value,
              sendAmount: value,
            },
          },
        })
      )
    ).toEqual({ transactionId: "mg_tx_created_1" });
  });

  it.each([{ value: 25 }, { value: null }, { value: false }, { value: {} }, { value: [] }])(
    "drops non-string custodial fields ($value)",
    ({ value }) => {
      expect(
        mapMoneygramTransferDetails(
          transferRow({
            provider_data: {
              moneygram: {
                transactionId: "mg_tx_created_1",
                mgiTransactionId: value,
                depositAddress: value,
                depositMemo: value,
                sendAmount: value,
              },
            },
          })
        )
      ).toEqual({ transactionId: "mg_tx_created_1" });
    }
  );
});
