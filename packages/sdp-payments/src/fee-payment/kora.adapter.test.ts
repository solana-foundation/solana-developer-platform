import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KoraAdapter, type KoraAdapterConfig } from "./kora.adapter";
import { FeePaymentError } from "./port";

type KoraTransport = NonNullable<KoraAdapterConfig["client"]>;

const SIGNER = "So11111111111111111111111111111111111111112";

const ALL_FALSE_AUTHORITY = {
  allow_transfer: false,
  allow_burn: false,
  allow_close_account: false,
  allow_approve: false,
  allow_revoke: false,
  allow_set_authority: false,
  allow_mint_to: false,
  allow_initialize_mint: false,
  allow_initialize_account: false,
  allow_initialize_multisig: false,
  allow_freeze_account: false,
  allow_thaw_account: false,
};

const ZERO_OUTFLOW_POLICY = {
  system: {
    allow_transfer: false,
    allow_assign: false,
    allow_create_account: false,
    allow_allocate: false,
    nonce: {
      allow_initialize: false,
      allow_advance: false,
      allow_authorize: false,
      allow_withdraw: false,
    },
  },
  spl_token: ALL_FALSE_AUTHORITY,
  token_2022: ALL_FALSE_AUTHORITY,
};

function makeAdapter(getConfig: () => Promise<unknown>): KoraAdapter {
  const transport = {
    getPayerSigner: async () => ({ signer_address: SIGNER }),
    signTransaction: async () => ({ signed_transaction: "" }),
    signAndSendTransaction: async () => ({ signed_transaction: "" }),
    estimateTransactionFee: async () => ({ fee_in_lamports: 0 }),
    getSupportedTokens: async () => ({ tokens: [] }),
    getConfig,
  } as unknown as KoraTransport;
  return new KoraAdapter({ rpcUrl: "https://kora.example", userId: "u1", client: transport });
}

describe("KoraAdapter.getSponsorshipConfiguration", () => {
  it("fails closed when Kora omits validation_config", async () => {
    const adapter = makeAdapter(async () => ({}));
    await assert.rejects(
      adapter.getSponsorshipConfiguration(),
      (error: unknown) =>
        error instanceof FeePaymentError && /validation_config/.test(String(error.cause?.message))
    );
  });

  it("fails closed when Kora omits max_allowed_lamports", async () => {
    const adapter = makeAdapter(async () => ({
      validation_config: { fee_payer_policy: ZERO_OUTFLOW_POLICY },
    }));
    await assert.rejects(
      adapter.getSponsorshipConfiguration(),
      (error: unknown) =>
        error instanceof FeePaymentError &&
        /max_allowed_lamports/.test(String(error.cause?.message))
    );
  });

  it("treats an incomplete fee_payer_policy as able to spend (fails closed)", async () => {
    const adapter = makeAdapter(async () => ({
      validation_config: {
        max_allowed_lamports: 1000,
        fee_payer_policy: { system: { allow_transfer: false } },
      },
    }));
    const config = await adapter.getSponsorshipConfiguration();
    assert.equal(config.maxAllowedLamports, 1000n);
    assert.equal(config.feePayerMayTransferLamports, true);
  });

  it("recognizes the complete zero-outflow policy as unable to spend", async () => {
    const adapter = makeAdapter(async () => ({
      validation_config: {
        max_allowed_lamports: 5000,
        fee_payer_policy: ZERO_OUTFLOW_POLICY,
      },
    }));
    const config = await adapter.getSponsorshipConfiguration();
    assert.equal(config.maxAllowedLamports, 5000n);
    assert.equal(config.feePayerMayTransferLamports, false);
  });
});
