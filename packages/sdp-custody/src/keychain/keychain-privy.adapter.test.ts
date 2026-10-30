import { SignerError, type SolanaSigner } from "@solana/keychain-core";
import { PrivySigner } from "@solana/keychain-privy";
import {
  address,
  assertIsTransactionWithinSizeLimit,
  blockhash,
  compileTransaction,
  createSignableMessage,
  createTransactionMessage,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { SigningError } from "#/signing";
import { KeychainPrivyAdapter } from "./keychain-privy.adapter";

const WALLET_ADDRESS = "11111111111111111111111111111111";

function signTestTransaction(signer: SolanaSigner) {
  const transaction = compileTransaction(
    pipe(
      createTransactionMessage({ version: 0 }),
      (message) => setTransactionMessageFeePayer(address(WALLET_ADDRESS), message),
      (message) =>
        setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash: blockhash("EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N"),
            lastValidBlockHeight: 1000n,
          },
          message
        )
    )
  );
  assertIsTransactionWithinSizeLimit(transaction);
  return signer.signTransactions([transaction]);
}

function signTestMessage(signer: SolanaSigner) {
  return signer.signMessages([createSignableMessage("Recurring payment authorization")]);
}

async function signAgainstRpcAnswer(rpcAnswer: Response, sign: typeof signTestTransaction) {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      Response.json({ id: "wallet-1", address: WALLET_ADDRESS, chain_type: "solana" })
    )
    .mockResolvedValueOnce(rpcAnswer);
  const adapter = new KeychainPrivyAdapter({ appId: "app-id", appSecret: "app-secret" });
  return sign(await adapter.getTransactionSigner("privy_wallet-1"));
}

function privyErrorAnswer(body: string): Response {
  return new Response(body, { status: 400 });
}

describe("privy adapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("evicts failed signer creation so subsequent calls can retry", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("temporary privy outage"))
      .mockResolvedValueOnce(
        Response.json({ id: "wallet-1", address: WALLET_ADDRESS, chain_type: "solana" })
      );
    const adapter = new KeychainPrivyAdapter({ appId: "app-id", appSecret: "app-secret" });

    await expect(adapter.getPublicKey("privy_wallet-1")).rejects.toThrow(
      "Privy network request failed"
    );
    await expect(adapter.getPublicKey("privy_wallet-1")).resolves.toBe(WALLET_ADDRESS);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const retryCall = fetchSpy.mock.calls[1];
    assert.isDefined(retryCall);
    expect(String(retryCall[0])).toContain("/wallets/wallet-1");
  });

  it("creates the Privy signer from its config and the unprefixed wallet id", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ id: "wallet-1", address: WALLET_ADDRESS, chain_type: "solana" })
    );
    const createSigner = vi.spyOn(PrivySigner, "create");
    const adapter = new KeychainPrivyAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      apiBaseUrl: "https://privy.test/v1",
      requestDelayMs: 250,
    });

    await expect(adapter.getPublicKey("privy_wallet-1")).resolves.toBe(WALLET_ADDRESS);

    expect(createSigner).toHaveBeenCalledExactlyOnceWith({
      appId: "app-id",
      appSecret: "app-secret",
      walletId: "wallet-1",
      apiBaseUrl: "https://privy.test/v1",
      requestDelayMs: 250,
    });
  });

  it("reuses one signer construction across successful calls", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        Response.json({ id: "wallet-1", address: WALLET_ADDRESS, chain_type: "solana" })
      );
    const adapter = new KeychainPrivyAdapter({ appId: "app-id", appSecret: "app-secret" });

    const first = await adapter.getTransactionSigner("privy_wallet-1");
    const second = await adapter.getTransactionSigner("privy_wallet-1");

    expect(second).toBe(first);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["signTransactions", signTestTransaction],
    ["signMessages", signTestMessage],
  ] as const)(
    "refuses a Privy policy violation from %s as POLICY_REFUSED, keeping Privy's error as its cause",
    async (_method, sign) => {
      const signing = signAgainstRpcAnswer(
        privyErrorAnswer(
          JSON.stringify({ error: "Policy denied this transaction", code: "policy_violation" })
        ),
        sign
      );

      await expect(signing).rejects.toThrow(SigningError);
      await expect(signing).rejects.toMatchObject({
        code: "POLICY_REFUSED",
        cause: expect.any(SignerError),
      });
    }
  );

  it("rethrows Privy's error unchanged for another error code", async () => {
    const signing = signAgainstRpcAnswer(
      privyErrorAnswer(JSON.stringify({ error: "Invalid transaction", code: "invalid_data" })),
      signTestTransaction
    );

    await expect(signing).rejects.toThrow(SignerError);
  });

  it.each([
    [401, { code: "invalid_credentials", error: "Invalid app credentials" }],
    [403, { error: "Forbidden" }],
    [429, { code: "rate_limit_exceeded", error: "Too many requests" }],
    [500, { error: "Internal error" }],
  ])("keeps HTTP %s errors distinct from policy refusals", async (status, body) => {
    const signing = signAgainstRpcAnswer(Response.json(body, { status }), signTestTransaction);

    await expect(signing).rejects.toBeInstanceOf(SignerError);
    await expect(signing).rejects.toMatchObject({ context: { status } });
  });

  it.each([
    ["signTransactions", signTestTransaction],
    ["signMessages", signTestMessage],
  ] as const)("retains a policy code beyond the truncated %s response", async (_method, sign) => {
    const signing = signAgainstRpcAnswer(
      privyErrorAnswer(JSON.stringify({ error: "x".repeat(500), code: "policy_violation" })),
      sign
    );

    await expect(signing).rejects.toMatchObject({
      code: "POLICY_REFUSED",
      cause: {
        context: {
          responseCode: "policy_violation",
          response: expect.not.stringContaining("policy_violation"),
        },
      },
    });
  });

  it.each([
    ["error text", JSON.stringify({ error: "policy_violation" })],
    ["nested code", JSON.stringify({ error: { code: "policy_violation" } })],
    ["invalid JSON", '{"code":"policy_violation",'],
    ["array", JSON.stringify([{ code: "policy_violation" }])],
    ["invalid code", JSON.stringify({ code: "policy_violation\n" })],
    ["oversized code", JSON.stringify({ code: "policy_violation".repeat(100) })],
  ])("does not infer a refusal from %s", async (_case, body) => {
    const signing = signAgainstRpcAnswer(privyErrorAnswer(body), signTestTransaction);

    await expect(signing).rejects.toBeInstanceOf(SignerError);
    await expect(signing).rejects.toMatchObject({ context: { responseCode: undefined } });
  });
});
