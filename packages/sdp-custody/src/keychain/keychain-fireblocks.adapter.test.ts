import { generateKeyPairSync } from "node:crypto";
import { SignerError, SignerErrorCode, type SolanaSigner } from "@solana/keychain-core";
import {
  address,
  assertIsTransactionWithinSizeLimit,
  blockhash,
  compileTransaction,
  createSignableMessage,
  createTransactionMessage,
  generateKeyPairSigner,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import type { MockInstance } from "vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SigningError } from "#/signing";
import { KeychainFireblocksAdapter } from "./keychain-fireblocks.adapter";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const CONFIG = {
  apiKey: "api-key",
  apiSecretPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  vaultAccountId: "default-vault",
};
const WALLET_ADDRESS = "11111111111111111111111111111111";
const CONSOLE_METHODS = ["debug", "log", "info", "warn", "error"] as const;
/** Fireblocks' documented answer for a transaction a policy rule blocked. */
const POLICY_BLOCK = { status: "BLOCKED", subStatus: "BLOCKED_BY_POLICY" };

/** Every argument every console sink received, as one searchable string. */
function collectLogLines(...sinks: MockInstance[]): string {
  return sinks
    .flatMap((sink) => sink.mock.calls)
    .map((call) => call.map((argument) => JSON.stringify(argument)).join(" "))
    .join("\n");
}

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
  return signer.signMessages([createSignableMessage("Fireblocks policy check")]);
}

/** A Fireblocks status read, including malformed sub-statuses the patch must drop. */
interface FireblocksPoll {
  status: string;
  subStatus?: string | { code: string };
  note?: string;
  errorDescription?: string;
}

/**
 * Signs once against Fireblocks accepting the RAW proposal and answering its
 * first status read with `poll`.
 */
async function signAgainstPoll(poll: FireblocksPoll, sign: typeof signTestTransaction) {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ addresses: [{ address: WALLET_ADDRESS }] }))
    .mockResolvedValueOnce(Response.json({ id: "tx-1", status: "SUBMITTED" }))
    .mockResolvedValueOnce(Response.json({ id: "tx-1", ...poll }));
  const adapter = new KeychainFireblocksAdapter(CONFIG);
  return sign(await adapter.getTransactionSigner("fb_vault-1"));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fireblocks adapter", () => {
  it("evicts failed signer initialization so subsequent calls can retry", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("temporary fireblocks outage"))
      .mockResolvedValueOnce(Response.json({ addresses: [{ address: WALLET_ADDRESS }] }));
    const adapter = new KeychainFireblocksAdapter(CONFIG);

    await expect(adapter.getPublicKey("fb_vault-1")).rejects.toThrow(
      "Fireblocks network request failed"
    );
    await expect(adapter.getPublicKey("fb_vault-1")).resolves.toBe(WALLET_ADDRESS);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    for (const [url] of fetchSpy.mock.calls) {
      expect(String(url)).toBe(
        "https://api.fireblocks.io/v1/vault/accounts/vault-1/SOL/addresses_paginated"
      );
    }
  });

  it("keeps real Fireblocks request and response bodies off every console sink", async () => {
    const sinks = CONSOLE_METHODS.map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {})
    );
    const wallet = await generateKeyPairSigner();
    const message = createSignableMessage("secret-signing-payload");
    const [expectedSignatures] = await wallet.signMessages([message]);
    const signatureHex = Buffer.from(expectedSignatures[wallet.address]).toString("hex");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ addresses: [{ address: wallet.address }] }))
      .mockResolvedValueOnce(Response.json({ id: "tx-1", note: "response-secret-value" }))
      .mockResolvedValueOnce(
        Response.json({
          status: "COMPLETED",
          signedMessages: [{ signature: { fullSig: signatureHex } }],
        })
      )
      .mockRejectedValueOnce(new TypeError("fireblocks is unavailable"));
    const adapter = new KeychainFireblocksAdapter(CONFIG);
    const signer = await adapter.getTransactionSigner();

    await expect(signer.signMessages([message])).resolves.toEqual([expectedSignatures]);
    await expect(signer.signMessages([message])).rejects.toThrow(
      "Fireblocks network request failed"
    );

    expect(fetchSpy).toHaveBeenCalledTimes(4);
    const payloadHex = Buffer.from(message.content).toString("hex");
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.fireblocks.io/v1/transactions",
      expect.objectContaining({ method: "POST", body: expect.stringContaining(payloadHex) })
    );
    const logged = collectLogLines(...sinks);
    expect(logged).not.toContain("secret-signing-payload");
    expect(logged).not.toContain(payloadHex);
    expect(logged).not.toContain("response-secret-value");
    expect(logged).not.toContain(signatureHex);
    expect(logged).not.toContain("fireblocks is unavailable");
  });
});

describe("fireblocks adapter policy refusals (HOO-2478)", () => {
  it.each([
    ["signTransactions", signTestTransaction],
    ["signMessages", signTestMessage],
  ] as const)(
    "refuses a Fireblocks policy block from %s as POLICY_REFUSED, keeping keychain's error as its cause",
    async (_method, sign) => {
      const signing = signAgainstPoll(POLICY_BLOCK, sign);

      await expect(signing).rejects.toBeInstanceOf(SigningError);
      await expect(signing).rejects.toMatchObject({
        code: "POLICY_REFUSED",
        cause: {
          code: SignerErrorCode.SIGNING_FAILED,
          context: { status: "BLOCKED", subStatus: "BLOCKED_BY_POLICY" },
        },
      });
    }
  );

  it.each<[string, FireblocksPoll]>([
    ["BLOCKED without a sub-status", { status: "BLOCKED" }],
    ["FAILED with a policy sub-status", { status: "FAILED", subStatus: "BLOCKED_BY_POLICY" }],
    ["REJECTED", { status: "REJECTED", subStatus: "AUTO_FREEZE" }],
    ["CANCELLED", { status: "CANCELLED", subStatus: "REJECTED_BY_USER" }],
    ["FAILED", { status: "FAILED", subStatus: "INSUFFICIENT_FUNDS" }],
  ])("keeps %s the provider's own failure", async (_case, poll) => {
    const signing = signAgainstPoll(poll, signTestTransaction);

    await expect(signing).rejects.toBeInstanceOf(SignerError);
    await expect(signing).rejects.toThrow(`Transaction failed with status: ${poll.status}`);
    await expect(signing).rejects.toMatchObject({
      code: SignerErrorCode.SIGNING_FAILED,
      context: { status: poll.status, subStatus: poll.subStatus },
    });
  });

  it.each<[string, FireblocksPoll["subStatus"]]>([
    ["lowercase", "blocked_by_policy"],
    ["trailing newline", "BLOCKED_BY_POLICY\n"],
    ["oversized", `BLOCKED_BY_POLICY${"_".repeat(100)}`],
    ["free-text", "Blocked by rule 7: private provider text"],
    ["nested", { code: "BLOCKED_BY_POLICY" }],
  ])("neither infers a refusal from nor keeps a %s sub-status", async (_case, subStatus) => {
    const signing = signAgainstPoll({ status: "BLOCKED", subStatus }, signTestTransaction);

    await expect(signing).rejects.toBeInstanceOf(SignerError);
    await expect(signing).rejects.toSatisfy(
      (error: SignerError) => error.context?.subStatus === undefined
    );
  });

  it("keeps polling a pending approval and returns the signature Fireblocks approves", async () => {
    const wallet = await generateKeyPairSigner();
    const message = createSignableMessage("approval-pending-payload");
    const [expectedSignatures] = await wallet.signMessages([message]);
    const signatureHex = Buffer.from(expectedSignatures[wallet.address]).toString("hex");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ addresses: [{ address: wallet.address }] }))
      .mockResolvedValueOnce(Response.json({ id: "tx-1", status: "SUBMITTED" }))
      .mockResolvedValueOnce(Response.json({ id: "tx-1", status: "PENDING_AUTHORIZATION" }))
      .mockResolvedValueOnce(
        Response.json({
          id: "tx-1",
          status: "COMPLETED",
          signedMessages: [{ signature: { fullSig: signatureHex } }],
        })
      );
    const adapter = new KeychainFireblocksAdapter({ ...CONFIG, pollIntervalMs: 1 });
    const signer = await adapter.getTransactionSigner();

    await expect(signer.signMessages([message])).resolves.toEqual([expectedSignatures]);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it("keeps the rest of a refused transaction's body off the error and every console sink", async () => {
    const sinks = CONSOLE_METHODS.map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {})
    );
    const refusal = await signAgainstPoll(
      { ...POLICY_BLOCK, note: "response-secret-value", errorDescription: "private rule text" },
      signTestMessage
    ).catch((cause: unknown) => cause);

    expect(refusal).toBeInstanceOf(SigningError);
    const serialized = JSON.stringify(refusal);
    expect(serialized).toContain("BLOCKED_BY_POLICY");
    for (const secret of ["response-secret-value", "private rule text"]) {
      expect(serialized).not.toContain(secret);
      expect(collectLogLines(...sinks)).not.toContain(secret);
    }
  });
});
