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

describe("signAndSend ambiguity verdict (maybeBroadcast)", () => {
  function makeAdapterWithSendSequence(errors: Array<string | Error>): KoraAdapter {
    let call = 0;
    const transport = {
      getPayerSigner: async () => ({ signer_address: SIGNER }),
      signTransaction: async () => ({ signed_transaction: "" }),
      signAndSendTransaction: async () => {
        const entry = errors[Math.min(call, errors.length - 1)];
        call += 1;
        throw entry instanceof Error ? entry : new Error(entry);
      },
      estimateTransactionFee: async () => ({ fee_in_lamports: 0 }),
      getSupportedTokens: async () => ({ tokens: [] }),
      getConfig: async () => ({ validation_config: {} }),
    } as unknown as KoraTransport;
    return new KoraAdapter({ rpcUrl: "https://kora.example", userId: "u1", client: transport });
  }

  async function captureSendError(adapter: KoraAdapter): Promise<FeePaymentError> {
    try {
      await adapter.signAndSend(new Uint8Array([1, 2, 3]));
    } catch (error) {
      assert.ok(error instanceof FeePaymentError);
      return error;
    }
    assert.fail("signAndSend unexpectedly succeeded");
  }

  it("keeps a first-attempt deterministic rejection un-flagged", async () => {
    const error = await captureSendError(
      makeAdapterWithSendSequence(["RPC Error -32002: insufficient balance for fee"])
    );
    assert.equal(error.code, "INSUFFICIENT_BALANCE");
    assert.equal(error.maybeBroadcast, false);
  });

  it("flags the final rejection after a timed-out attempt, preserving its code", async () => {
    // The first attempt may have landed; the retry's "insufficient balance"
    // can be CAUSED by that hidden broadcast. The verdict travels as data —
    // the code stays, the flag says it cannot be trusted as pre-broadcast.
    const error = await captureSendError(
      makeAdapterWithSendSequence([
        "Kora signAndSendTransaction timed out after 10000ms",
        "RPC Error -32002: insufficient balance for fee",
      ])
    );
    assert.equal(error.code, "INSUFFICIENT_BALANCE");
    assert.equal(error.maybeBroadcast, true);
  });

  it("flags the final simulation rejection after a dropped connection", async () => {
    const error = await captureSendError(
      makeAdapterWithSendSequence([
        "socket hang up ECONNRESET",
        "RPC Error -32000: Transaction simulation failed: custom program error: 0x1",
      ])
    );
    assert.equal(error.code, "NETWORK_ERROR");
    assert.equal(error.maybeBroadcast, true);
  });

  it("does not flag after a refused connection (nothing was ever sent)", async () => {
    const error = await captureSendError(
      makeAdapterWithSendSequence([
        "connect ECONNREFUSED 127.0.0.1:8080",
        "RPC Error -32002: insufficient balance for fee",
      ])
    );
    assert.equal(error.code, "INSUFFICIENT_BALANCE");
    assert.equal(error.maybeBroadcast, false);
  });

  it("flags exhausted retries on ambiguous transport errors", async () => {
    const error = await captureSendError(
      makeAdapterWithSendSequence(["Kora signAndSendTransaction timed out after 10000ms"])
    );
    assert.equal(error.code, "NETWORK_ERROR");
    assert.equal(error.maybeBroadcast, true);
  });

  // Node's fetch (undici) never says "econnrefused" in the top-level message:
  // it throws "fetch failed" and keeps the socket error in `cause`.
  function undiciRefusedConnection(): Error {
    return new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8080"), {
        code: "ECONNREFUSED",
      }),
    });
  }

  it("certifies pre-broadcast when every attempt is a refused connection (undici shape)", async () => {
    // A refused connection was never established, so a total Kora outage is a
    // provably pre-broadcast failure — terminal failed, not a 409 wedge.
    const error = await captureSendError(makeAdapterWithSendSequence([undiciRefusedConnection()]));
    assert.equal(error.code, "NETWORK_ERROR");
    assert.equal(error.maybeBroadcast, false);
    assert.equal(error.preBroadcast, true);
  });

  it("certifies pre-broadcast for a raw-message refused connection as the final error", async () => {
    const error = await captureSendError(
      makeAdapterWithSendSequence(["connect ECONNREFUSED 127.0.0.1:8080"])
    );
    assert.equal(error.maybeBroadcast, false);
    assert.equal(error.preBroadcast, true);
  });

  it("certifies pre-broadcast from the adapter's own HTTP failure", async () => {
    // Drives the real request path of the identity-token client, which is what
    // a managed deployment uses: the message asserted on below is built at that
    // throw site, so rewording it there fails here instead of silently sending
    // every 401 back to parking. The vendored client used without a Cloud Run
    // audience raises its own error shape, which we have not pinned.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("nope", { status: 401 })) as unknown as typeof fetch;
    try {
      const adapter = new KoraAdapter({
        rpcUrl: "https://kora.example",
        userId: "u1",
        identityTokenAudience: "https://kora.example",
        identityTokenProvider: async () => "token",
      });
      const error = await captureSendError(adapter);
      assert.equal(error.maybeBroadcast, false);
      assert.equal(error.preBroadcast, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("certifies pre-broadcast when Kora refuses the request at its HTTP layer", async () => {
    // A 4xx is Kora answering before it ever looked at the transaction — a bad
    // or missing Cloud Run audience answers 401 for every call. Parking those
    // would put every payment of a misconfigured deployment behind an operator.
    const error = await captureSendError(makeAdapterWithSendSequence(["Kora HTTP 401"]));
    assert.equal(error.maybeBroadcast, false);
    assert.equal(error.preBroadcast, true);
  });

  it("leaves a Kora gateway failure ambiguous", async () => {
    // 5xx can be a proxy giving up after Kora already submitted.
    const error = await captureSendError(makeAdapterWithSendSequence(["Kora HTTP 503"]));
    assert.equal(error.preBroadcast, false);
  });

  it("certifies pre-broadcast when the identity token could not be obtained", async () => {
    // The request never left this process, so nothing can have been submitted —
    // including when the metadata server answers with a retryable-looking code.
    const error = await captureSendError(
      makeAdapterWithSendSequence(["Cloud Run identity token request failed with HTTP 503"])
    );
    assert.equal(error.maybeBroadcast, false);
    assert.equal(error.preBroadcast, true);
  });

  it("keeps an HTTP refusal ambiguous once an earlier attempt may have broadcast", async () => {
    const error = await captureSendError(
      makeAdapterWithSendSequence([
        "Kora signAndSendTransaction timed out after 10000ms",
        "Kora HTTP 401",
      ])
    );
    assert.equal(error.maybeBroadcast, true);
    assert.equal(error.preBroadcast, false);
  });

  it("keeps a refused final connection ambiguous once an earlier attempt may have broadcast", async () => {
    const error = await captureSendError(
      makeAdapterWithSendSequence([
        "Kora signAndSendTransaction timed out after 10000ms",
        undiciRefusedConnection(),
      ])
    );
    assert.equal(error.maybeBroadcast, true);
    assert.equal(error.preBroadcast, false);
  });
});
