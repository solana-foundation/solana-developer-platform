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

function makeAdapterRejectingSend(rpcErrorMessage: string): KoraAdapter {
  const transport = {
    getPayerSigner: async () => ({ signer_address: SIGNER }),
    signTransaction: async () => ({ signed_transaction: "" }),
    signAndSendTransaction: async () => {
      throw new Error(rpcErrorMessage);
    },
    estimateTransactionFee: async () => ({ fee_in_lamports: 0 }),
    getSupportedTokens: async () => ({ tokens: [] }),
    getConfig: async () => ({}),
  } as unknown as KoraTransport;
  return new KoraAdapter({ rpcUrl: "https://kora.example", userId: "u1", client: transport });
}

function makeAdapterFlakySend(failures: number, failure: () => Error): KoraAdapter {
  let attempts = 0;
  const transport = {
    getPayerSigner: async () => ({ signer_address: SIGNER }),
    signTransaction: async () => ({ signed_transaction: "" }),
    signAndSendTransaction: async () => {
      attempts += 1;
      if (attempts <= failures) throw failure();
      return { signature: "sig111" };
    },
    estimateTransactionFee: async () => ({ fee_in_lamports: 0 }),
    getSupportedTokens: async () => ({ tokens: [] }),
    getConfig: async () => ({}),
  } as unknown as KoraTransport;
  return new KoraAdapter({ rpcUrl: "https://kora.example", userId: "u1", client: transport });
}

describe("KoraAdapter transient-failure handling", () => {
  it("retries signAndSend through a connection-level failure", async () => {
    const adapter = makeAdapterFlakySend(2, () => new TypeError("fetch failed"));
    const signature = await adapter.signAndSend(new Uint8Array([1]));
    assert.equal(signature, "sig111");
  });

  it("gives up after exhausting retries on connection-level failures", async () => {
    const adapter = makeAdapterFlakySend(3, () => new TypeError("fetch failed"));
    await assert.rejects(
      adapter.signAndSend(new Uint8Array([1])),
      (error: unknown) => error instanceof FeePaymentError && error.message.includes("fetch failed")
    );
  });

  it("fails a hung call at the configured timeout instead of hanging", async () => {
    const transport = {
      getPayerSigner: () => new Promise(() => {}),
      signTransaction: async () => ({ signed_transaction: "" }),
      signAndSendTransaction: async () => ({ signed_transaction: "" }),
      estimateTransactionFee: async () => ({ fee_in_lamports: 0 }),
      getSupportedTokens: async () => ({ tokens: [] }),
      getConfig: async () => ({}),
    } as unknown as KoraTransport;
    const adapter = new KoraAdapter({
      rpcUrl: "https://kora.example",
      userId: "u1",
      client: transport,
      timeoutMs: 20,
    });
    await assert.rejects(
      adapter.getFeePayer(),
      (error: unknown) => error instanceof FeePaymentError && error.message.includes("timed out")
    );
  });
});

describe("KoraAdapter error classification", () => {
  it("treats a generic Kora server error as ambiguous, not a deterministic rejection", async () => {
    const adapter = makeAdapterRejectingSend("RPC Error -32000: server exploded");
    await assert.rejects(
      adapter.signAndSend(new Uint8Array(64)),
      (error: unknown) => error instanceof FeePaymentError && error.code === "NETWORK_ERROR"
    );
  });

  it("keeps invalid-request rejections deterministic", async () => {
    const adapter = makeAdapterRejectingSend("RPC Error -32602: invalid params");
    await assert.rejects(
      adapter.signAndSend(new Uint8Array(64)),
      (error: unknown) => error instanceof FeePaymentError && error.code === "SIGNING_FAILED"
    );
  });

  it("keeps rate limits deterministic and releasable", async () => {
    const adapter = makeAdapterRejectingSend("RPC Error -32001: rate limited");
    await assert.rejects(
      adapter.signAndSend(new Uint8Array(64)),
      (error: unknown) => error instanceof FeePaymentError && error.code === "RATE_LIMITED"
    );
  });
});

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
