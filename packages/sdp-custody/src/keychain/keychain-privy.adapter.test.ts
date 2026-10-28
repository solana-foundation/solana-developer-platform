import { SignerError } from "@solana/keychain-core";
import { PrivySigner } from "@solana/keychain-privy";
import {
  address,
  assertIsTransactionWithinSizeLimit,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { SigningError } from "#/signing";
import { KeychainPrivyAdapter } from "./keychain-privy.adapter";

const WALLET_ADDRESS = "11111111111111111111111111111111";

async function signAgainstRpcAnswer(rpcAnswer: Response) {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      Response.json({ id: "wallet-1", address: WALLET_ADDRESS, chain_type: "solana" })
    )
    .mockResolvedValueOnce(rpcAnswer);
  const adapter = new KeychainPrivyAdapter({ appId: "app-id", appSecret: "app-secret" });
  const signer = await adapter.getTransactionSigner("privy_wallet-1");
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

  it("refuses a Privy policy violation as POLICY_REFUSED, keeping Privy's error as its cause", async () => {
    const signing = signAgainstRpcAnswer(
      privyErrorAnswer(
        JSON.stringify({ error: "Policy denied this transaction", code: "policy_violation" })
      )
    );

    await expect(signing).rejects.toThrow(SigningError);
    await expect(signing).rejects.toMatchObject({
      code: "POLICY_REFUSED",
      cause: expect.any(SignerError),
    });
  });

  it("rethrows Privy's error unchanged for another error code", async () => {
    const signing = signAgainstRpcAnswer(
      privyErrorAnswer(JSON.stringify({ error: "Invalid transaction", code: "invalid_data" }))
    );

    await expect(signing).rejects.toThrow(SignerError);
  });

  it("rethrows Privy's error unchanged for a body that is not JSON", async () => {
    const signing = signAgainstRpcAnswer(privyErrorAnswer("<html>Bad Request</html>"));

    await expect(signing).rejects.toThrow(SignerError);
  });

  it("rethrows Privy's error unchanged when keychain truncated a policy violation body", async () => {
    const signing = signAgainstRpcAnswer(
      privyErrorAnswer(JSON.stringify({ code: "policy_violation", error: "x".repeat(300) }))
    );

    await expect(signing).rejects.toThrow(SignerError);
  });
});
