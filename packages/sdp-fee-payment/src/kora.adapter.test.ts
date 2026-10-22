import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KoraAdapter, type KoraAdapterConfig } from "./kora.adapter";
import { FeePaymentError, type FeePaymentErrorCode } from "./port";

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
    estimateTransactionFee: async () => ({ fee_in_lamports: 0 }),
    getSupportedTokens: async () => ({ tokens: [] }),
    getConfig,
  } as unknown as KoraTransport;
  return new KoraAdapter({ rpcUrl: "https://kora.example", userId: "u1", client: transport });
}

const USER_ID = "user_fee_payment_test";

function syntheticSigner(read: number): string {
  return `${"1".repeat(31)}${read + 1}`;
}

async function unstubbed(): Promise<never> {
  throw new Error("not stubbed in this test");
}

function koraTransport(
  stubs: Pick<KoraTransport, "getPayerSigner" | "signTransaction">
): KoraTransport {
  return {
    ...stubs,
    estimateTransactionFee: unstubbed,
    getSupportedTokens: unstubbed,
    getConfig: unstubbed,
  };
}

function refusalGate(): { promise: Promise<never>; refuse: (error: Error) => void } {
  let refuse: (error: Error) => void = () => {};
  const promise = new Promise<never>((_resolve, reject) => {
    refuse = reject;
  });
  return { promise, refuse };
}

describe("KoraAdapter transient-failure handling", () => {
  it("fails a hung call at the configured timeout instead of hanging", async () => {
    const adapter = new KoraAdapter({
      rpcUrl: "https://kora-hung.mock.invalid",
      userId: USER_ID,
      client: koraTransport({
        getPayerSigner: () => new Promise<never>(() => {}),
        signTransaction: unstubbed,
      }),
      timeoutMs: 20,
    });
    await assert.rejects(
      adapter.getFeePayer(),
      (error: unknown) => error instanceof FeePaymentError && error.message.includes("timed out")
    );
  });
});

describe("KoraAdapter fee-payer address cache", () => {
  it("serves one read of a Kora's address to every adapter on its URL, and only its URL", async () => {
    let reads = 0;
    const client = koraTransport({
      getPayerSigner: async () => {
        reads += 1;
        return { signer_address: syntheticSigner(reads) };
      },
      signTransaction: unstubbed,
    });
    const sharedUrl = "https://kora-shared.mock.invalid";
    const first = new KoraAdapter({ rpcUrl: sharedUrl, userId: "user_a", client });
    const second = new KoraAdapter({ rpcUrl: sharedUrl, userId: "user_b", client });

    assert.deepEqual(await Promise.all([first.getFeePayer(), second.getFeePayer()]), [
      syntheticSigner(1),
      syntheticSigner(1),
    ]);
    const later = new KoraAdapter({ rpcUrl: sharedUrl, userId: "user_c", client });
    assert.equal(await later.getFeePayer(), syntheticSigner(1));
    const otherKora = new KoraAdapter({
      rpcUrl: "https://kora-other.mock.invalid",
      userId: "user_a",
      client,
    });
    assert.equal(await otherKora.getFeePayer(), syntheticSigner(2));
    assert.equal(reads, 2);
  });

  it("never stores a failed read, including an answer that is not an address", async () => {
    let reads = 0;
    const adapter = new KoraAdapter({
      rpcUrl: "https://kora-fails-once.mock.invalid",
      userId: USER_ID,
      client: koraTransport({
        getPayerSigner: async () => {
          reads += 1;
          return { signer_address: reads === 1 ? "not-an-address" : SIGNER };
        },
        signTransaction: unstubbed,
      }),
    });

    await assert.rejects(adapter.getFeePayer(), FeePaymentError);
    assert.equal(await adapter.getFeePayer(), SIGNER);
    assert.equal(reads, 2);
  });

  it("rejects a refused sign as PROVIDER_REJECTED and re-reads only for the refused adapter", async () => {
    let reads = 0;
    const signerKeys: Array<string | undefined> = [];
    const firstRefusal = refusalGate();
    const lateRefusal = refusalGate();
    const client = koraTransport({
      getPayerSigner: async () => {
        reads += 1;
        return { signer_address: syntheticSigner(reads) };
      },
      signTransaction: (request) => {
        signerKeys.push(request.signer_key);
        return signerKeys.length === 1 ? firstRefusal.promise : lateRefusal.promise;
      },
    });
    const rotatingUrl = "https://kora-rotating.mock.invalid";
    const adapter = new KoraAdapter({ rpcUrl: rotatingUrl, userId: USER_ID, client });
    const bystander = new KoraAdapter({ rpcUrl: rotatingUrl, userId: "user_bystander", client });

    assert.equal(await adapter.getFeePayer(), syntheticSigner(1));
    assert.equal(await bystander.getFeePayer(), syntheticSigner(1));
    const refusedFirst = adapter.signAsFeePayer(new Uint8Array([1]));
    const refusedLate = adapter.signAsFeePayer(new Uint8Array([2]));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(signerKeys, [syntheticSigner(1), syntheticSigner(1)]);

    firstRefusal.refuse(new Error("RPC Error -32001: signer_key is not a Kora signer"));
    await assert.rejects(
      refusedFirst,
      (error: unknown) => error instanceof FeePaymentError && error.code === "PROVIDER_REJECTED"
    );
    assert.equal(await adapter.getFeePayer(), syntheticSigner(2));
    assert.equal(await bystander.getFeePayer(), syntheticSigner(1));

    lateRefusal.refuse(new Error("RPC Error -32001: signer_key is not a Kora signer"));
    await assert.rejects(refusedLate, FeePaymentError);
    assert.equal(await adapter.getFeePayer(), syntheticSigner(2));
    assert.equal(reads, 2);
  });

  it("rejects a sign that failed without a JSON-RPC code as NETWORK_ERROR and keeps the address", async () => {
    let reads = 0;
    const client = koraTransport({
      getPayerSigner: async () => {
        reads += 1;
        return { signer_address: SIGNER };
      },
      signTransaction: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const unreachableUrl = "https://kora-unreachable.mock.invalid";
    const adapter = new KoraAdapter({ rpcUrl: unreachableUrl, userId: USER_ID, client });

    await assert.rejects(
      adapter.signAsFeePayer(new Uint8Array([1])),
      (error: unknown) => error instanceof FeePaymentError && error.code === "NETWORK_ERROR"
    );
    const nextRequest = new KoraAdapter({ rpcUrl: unreachableUrl, userId: USER_ID, client });
    assert.equal(await nextRequest.getFeePayer(), SIGNER);
    assert.equal(reads, 1);
  });
});

describe("KoraAdapter sign refusals", () => {
  it("maps each Kora refusal of a sign to its FeePaymentError code", async () => {
    const refusals: Array<[Error, FeePaymentErrorCode]> = [
      [new Error("RPC Error -32090: server exploded"), "NETWORK_ERROR"],
      [new Error("RPC Error -32000: Invalid transaction: simulation failed"), "PROVIDER_REJECTED"],
      [
        new Error("Kora Error -32001: Validation error: mutable mint authority"),
        "PROVIDER_REJECTED",
      ],
      [
        Object.assign(new Error("Kora Error -32603: wrapped"), { code: -32003 }),
        "INSUFFICIENT_BALANCE",
      ],
      [new Error("RPC Error -32602: invalid params"), "SIGNING_FAILED"],
      [new Error("Kora Error -32030: Rate limit exceeded"), "RATE_LIMITED"],
    ];
    for (const [refusal, expectedCode] of refusals) {
      const adapter = new KoraAdapter({
        rpcUrl: "https://kora-refusals.mock.invalid",
        userId: USER_ID,
        client: koraTransport({
          getPayerSigner: async () => ({ signer_address: SIGNER }),
          signTransaction: async () => {
            throw refusal;
          },
        }),
      });
      await assert.rejects(
        adapter.signAsFeePayer(new Uint8Array([1])),
        (error: unknown) => error instanceof FeePaymentError && error.code === expectedCode,
        refusal.message
      );
    }
  });
});

describe("KoraAdapter Cloud Run identity token cache", () => {
  it("shares one metadata fetch per audience across adapters and never stores a failed one", async (t) => {
    const koraUrl = "https://kora-identity.mock.invalid";
    let metadataFetches = 0;
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
      if (String(input).startsWith("http://metadata.google.internal/")) {
        metadataFetches += 1;
        return metadataFetches === 1
          ? new Response("", { status: 503 })
          : new Response("synthetic-identity-token");
      }
      return Response.json({ jsonrpc: "2.0", id: 1, result: { tokens: [] } });
    });
    const first = new KoraAdapter({
      rpcUrl: koraUrl,
      userId: "user_a",
      identityTokenAudience: koraUrl,
    });
    const second = new KoraAdapter({
      rpcUrl: koraUrl,
      userId: "user_b",
      identityTokenAudience: koraUrl,
    });

    await assert.rejects(first.getSupportedTokens(), FeePaymentError);
    assert.deepEqual(await Promise.all([first.getSupportedTokens(), second.getSupportedTokens()]), [
      [],
      [],
    ]);
    assert.deepEqual(await second.getSupportedTokens(), []);
    assert.equal(metadataFetches, 2);
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
