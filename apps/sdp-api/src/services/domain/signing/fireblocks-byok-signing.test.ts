import { generateKeyPairSync, sign } from "node:crypto";
import { isFullSigningPort } from "@sdp/custody/signing";
import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  assertIsTransactionWithinSizeLimit,
  blockhash,
  compileTransaction,
  createSignableMessage,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  isFullySignedTransaction,
  isMessagePartialSigner,
  isTransactionPartialSigner,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { afterEach, aroundEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import { inSandboxScope } from "@/test/helpers/cluster-rpc";
import { env as testEnv } from "@/test/helpers/env";
import { admittedSigner } from "./admitted-signer";
import { createFireblocksAdapterFromCredential } from "./provider-adapter-factory";

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ed25519 = generateKeyPairSync("ed25519");
const publicKey = address(
  getBase58Decoder().decode(
    new Uint8Array(ed25519.publicKey.export({ format: "der", type: "spki" }).subarray(-32))
  )
);
const apiSecretPem = rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const env = {
  ...testEnv,
  SDP_RELEASE_CHANNEL: "beta",
  FIREBLOCKS_API_BASE_URL: "https://fireblocks.example.test",
  FIREBLOCKS_API_KEY: "deployment-key",
  FIREBLOCKS_API_SECRET: "deployment-secret",
};

const CREDENTIAL: Parameters<typeof createFireblocksAdapterFromCredential>[1] = {
  apiKey: "tenant-key",
  apiSecretPem,
  assetId: "SOL_TEST",
  walletId: "fb_42",
};

afterEach(() => vi.restoreAllMocks());
aroundEach((runTest) => inSandboxScope(runTest));

function testTransaction(version: 0 | "legacy" = 0, payer = publicKey) {
  const transaction = compileTransaction(
    pipe(
      createTransactionMessage({ version }),
      (message) => setTransactionMessageFeePayer(payer, message),
      (message) =>
        setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash: blockhash("11111111111111111111111111111111"),
            lastValidBlockHeight: 100n,
          },
          message
        ),
      (message) =>
        appendTransactionMessageInstruction(
          {
            programAddress: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
            accounts: [{ address: publicKey, role: AccountRole.READONLY_SIGNER }],
            data: new TextEncoder().encode("arbitrary program instruction"),
          },
          message
        )
    )
  );
  assertIsTransactionWithinSizeLimit(transaction);
  return transaction;
}

describe("Fireblocks BYOK transaction proposals", () => {
  it.each(["stable", "beta", "experimental"])(
    "proposes a sign-only PROGRAM_CALL in %s, waits for SIGNED and never broadcasts",
    async (channel) => {
      const transaction = testTransaction();
      const signature = sign(null, Buffer.from(transaction.messageBytes), ed25519.privateKey);
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(Response.json({ addresses: [{ address: publicKey }] }))
        .mockResolvedValueOnce(Response.json({ id: "proposal-1", status: "PENDING_AUTHORIZATION" }))
        .mockResolvedValueOnce(Response.json({ id: "proposal-1", status: "PENDING_AUTHORIZATION" }))
        .mockResolvedValueOnce(
          Response.json({
            id: "proposal-1",
            status: "SIGNED",
            signedMessages: [{ signature: { fullSig: signature.toString("hex") } }],
          })
        );
      const releaseEnv = { ...env, SDP_RELEASE_CHANNEL: channel };
      const adapter = createFireblocksAdapterFromCredential(releaseEnv, CREDENTIAL);
      if (!isFullSigningPort(adapter)) throw new Error("Expected signing adapter");
      const signer = await adapter.getTransactionSigner("fb_42", publicKey);
      expect(signer).not.toHaveProperty("signAndSendTransactions");
      if (!("signTransactions" in signer)) throw new Error("Expected partial signer");
      const signatures = await signer.signTransactions([transaction]);
      expect(Buffer.from(signatures[0]?.[publicKey] ?? [])).toEqual(signature);
      expect(fetch).toHaveBeenCalledTimes(4);
      const proposal = fetch.mock.calls[1];
      expect(proposal?.[0]).toBe(`${env.FIREBLOCKS_API_BASE_URL}/v1/transactions`);
      expect(JSON.parse(String(proposal?.[1]?.body))).toEqual({
        externalTxId: expect.stringMatching(/^sdp-sign-/),
        operation: "PROGRAM_CALL",
        assetId: "SOL_TEST",
        source: { type: "VAULT_ACCOUNT", id: "42" },
        extraParameters: {
          programCallData: getBase64EncodedWireTransaction(transaction),
          signOnly: true,
          useDurableNonce: false,
        },
      });
      for (const [url, init] of fetch.mock.calls) {
        expect(String(url).startsWith(env.FIREBLOCKS_API_BASE_URL)).toBe(true);
        expect(new Headers(init?.headers).get("X-API-Key")).toBe("tenant-key");
      }
      expect(await adapter.getTransactionSigner("fb_42", publicKey)).toBe(signer);
      expect(fetch).toHaveBeenCalledTimes(4);
    }
  );

  it.each([0, "legacy"] as const)(
    "preserves message bytes and other signatures for %s transactions",
    async (version) => {
      const sponsor = await generateKeyPairSigner();
      const transaction = await partiallySignTransaction(
        [sponsor.keyPair],
        testTransaction(version, sponsor.address)
      );
      const signature = sign(null, Buffer.from(transaction.messageBytes), ed25519.privateKey);
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(Response.json({ addresses: [{ address: publicKey }] }))
        .mockResolvedValueOnce(Response.json({ id: "proposal-sponsored", status: "SUBMITTED" }))
        .mockResolvedValueOnce(
          Response.json({
            status: "SIGNED",
            signedMessages: [{ signature: { fullSig: signature.toString("hex") } }],
          })
        );
      const adapter = createFireblocksAdapterFromCredential(
        { ...env, SDP_RELEASE_CHANNEL: "stable" },
        CREDENTIAL
      );
      if (!isFullSigningPort(adapter)) throw new Error("Expected signing adapter");
      const signer = await adapter.getTransactionSigner();
      if (!isTransactionPartialSigner(signer)) throw new Error("Expected partial signer");
      const [signatures] = await signer.signTransactions([transaction]);
      const proposal = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
      const sent = getTransactionDecoder().decode(
        new Uint8Array(Buffer.from(proposal.extraParameters.programCallData, "base64"))
      );
      expect(sent.messageBytes).toEqual(transaction.messageBytes);
      expect(sent.signatures[sponsor.address]).toEqual(transaction.signatures[sponsor.address]);
      expect(proposal.extraParameters).toMatchObject({ signOnly: true, useDurableNonce: false });
      expect(
        isFullySignedTransaction({
          ...transaction,
          signatures: { ...transaction.signatures, ...signatures },
        })
      ).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(3);
    }
  );

  it("mints a distinct external ID for each proposal on a cached signer", async () => {
    const transaction = testTransaction();
    const signature = sign(null, Buffer.from(transaction.messageBytes), ed25519.privateKey);
    const signed = () =>
      Response.json({
        status: "SIGNED",
        signedMessages: [{ signature: { fullSig: signature.toString("hex") } }],
      });
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ addresses: [{ address: publicKey }] }))
      .mockResolvedValueOnce(Response.json({ id: "proposal-1" }))
      .mockResolvedValueOnce(signed())
      .mockResolvedValueOnce(Response.json({ id: "proposal-2" }))
      .mockResolvedValueOnce(signed());
    const adapter = createFireblocksAdapterFromCredential(env, {
      ...CREDENTIAL,
      requestDelayMs: 0,
    });
    if (!isFullSigningPort(adapter)) throw new Error("Expected signing adapter");
    const signer = await adapter.getTransactionSigner();
    if (!isTransactionPartialSigner(signer)) throw new Error("Expected partial signer");
    await signer.signTransactions([transaction]);
    expect(await adapter.getTransactionSigner()).toBe(signer);
    await signer.signTransactions([transaction]);
    const externalIds = fetch.mock.calls
      .filter(([, init]) => init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init?.body)).externalTxId);
    expect(externalIds).toHaveLength(2);
    expect(new Set(externalIds).size).toBe(2);
    expect(externalIds).toEqual([
      expect.stringMatching(/^sdp-sign-/),
      expect.stringMatching(/^sdp-sign-/),
    ]);
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("keeps off-chain message signing on RAW when program calls are enabled", async () => {
    const message = createSignableMessage("ownership proof");
    const signature = sign(null, message.content, ed25519.privateKey);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ addresses: [{ address: publicKey }] }))
      .mockResolvedValueOnce(Response.json({ id: "message-1", status: "SUBMITTED" }))
      .mockResolvedValueOnce(
        Response.json({
          id: "message-1",
          status: "COMPLETED",
          signedMessages: [{ signature: { fullSig: signature.toString("hex") } }],
        })
      );
    const adapter = createFireblocksAdapterFromCredential(env, CREDENTIAL);
    if (!isFullSigningPort(adapter)) throw new Error("Expected full signing port");
    const signer = await adapter.getTransactionSigner();
    if (!isMessagePartialSigner(signer)) throw new Error("Expected message signer");
    const [signatures] = await signer.signMessages([message]);
    expect(Buffer.from(signatures[publicKey])).toEqual(signature);
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({ operation: "RAW" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("stops polling a pending proposal when the caller aborts", async () => {
    const controller = new AbortController();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ addresses: [{ address: publicKey }] }))
      .mockResolvedValueOnce(Response.json({ id: "proposal-1", status: "SUBMITTED" }))
      .mockImplementationOnce(async () => {
        controller.abort(new Error("workflow deadline"));
        return Response.json({ id: "proposal-1", status: "PENDING_AUTHORIZATION" });
      })
      .mockResolvedValueOnce(Response.json({ success: true }));
    const adapter = createFireblocksAdapterFromCredential(env, CREDENTIAL);
    if (!isFullSigningPort(adapter)) throw new Error("Expected full signing port");
    const signer = await adapter.getTransactionSigner();
    if (!isTransactionPartialSigner(signer)) throw new Error("Expected partial signer");
    await expect(
      signer.signTransactions([testTransaction()], {
        abortSignal: controller.signal,
      })
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
    expect(fetch.mock.calls[3]?.[0]).toBe(
      `${env.FIREBLOCKS_API_BASE_URL}/v1/transactions/proposal-1/cancel`
    );
  });

  it.each(["BROADCASTING", "CONFIRMING", "COMPLETED"])(
    "refuses %s as a sign-only result",
    async (status) => {
      const transaction = testTransaction();
      const signature = sign(null, Buffer.from(transaction.messageBytes), ed25519.privateKey);
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(Response.json({ addresses: [{ address: publicKey }] }))
        .mockResolvedValueOnce(Response.json({ id: "proposal-1", status: "SUBMITTED" }))
        .mockResolvedValueOnce(
          Response.json({
            id: "proposal-1",
            status,
            signedMessages: [{ signature: { fullSig: signature.toString("hex") } }],
          })
        );
      const adapter = createFireblocksAdapterFromCredential(env, CREDENTIAL);
      if (!isFullSigningPort(adapter)) throw new Error("Expected signing adapter");
      const signer = await adapter.getTransactionSigner();
      if (!isTransactionPartialSigner(signer)) throw new Error("Expected partial signer");
      await expect(signer.signTransactions([transaction])).rejects.toMatchObject({
        code: "SIGNER_BROADCAST_UNCONFIRMED",
        context: { providerTransactionId: "proposal-1" },
      });
      expect(fetch).toHaveBeenCalledTimes(3);
    }
  );

  it("rejects a signature over different message bytes without trying RAW", async () => {
    const signature = sign(null, Buffer.from("changed transaction"), ed25519.privateKey);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ addresses: [{ address: publicKey }] }))
      .mockResolvedValueOnce(Response.json({ id: "proposal-1", status: "SUBMITTED" }))
      .mockResolvedValueOnce(
        Response.json({
          id: "proposal-1",
          status: "SIGNED",
          signedMessages: [{ signature: { fullSig: signature.toString("hex") } }],
        })
      );
    const adapter = createFireblocksAdapterFromCredential(env, CREDENTIAL);
    if (!isFullSigningPort(adapter)) throw new Error("Expected signing adapter");
    const signer = await adapter.getTransactionSigner();
    if (!isTransactionPartialSigner(signer)) throw new Error("Expected partial signer");
    await expect(signer.signTransactions([testTransaction()])).rejects.toMatchObject({
      code: "SIGNER_SIGNING_FAILED",
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe("Fireblocks BYOK policy refusals (HOO-2478)", () => {
  /** Signs through the shared custody signer while Fireblocks answers the proposal with `poll`. */
  async function signAgainstPoll(poll: { status: string; subStatus?: string; note?: string }) {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ addresses: [{ address: publicKey }] }))
      .mockResolvedValueOnce(Response.json({ id: "proposal-1", status: "SUBMITTED" }))
      .mockResolvedValueOnce(Response.json({ id: "proposal-1", ...poll }));
    const adapter = createFireblocksAdapterFromCredential(env, CREDENTIAL);
    if (!isFullSigningPort(adapter)) throw new Error("Expected signing adapter");
    const signer = admittedSigner(
      await adapter.getTransactionSigner("fb_42", publicKey),
      async () => ({ admitted: true }),
      {
        movement: "payments.transfer",
        organizationId: "org_fireblocks_refusal",
        projectId: "prj_fireblocks_refusal",
        custodyWalletId: "cwlt_fireblocks_refusal",
        provider: "fireblocks",
        credential: null,
      }
    );
    if (!isTransactionPartialSigner(signer)) throw new Error("Expected partial signer");
    return signer.signTransactions([testTransaction()]);
  }

  it("answers a policy block as CUSTODY_POLICY_REFUSED without the provider's wording", async () => {
    const refusal = await signAgainstPoll({
      status: "BLOCKED",
      subStatus: "BLOCKED_BY_POLICY",
      note: "private provider text",
    }).catch((cause: unknown) => cause);

    expect(refusal).toBeInstanceOf(AppError);
    expect(refusal).toMatchObject({
      code: "CUSTODY_POLICY_REFUSED",
      statusCode: 422,
      message:
        "Fireblocks blocked signing due to a wallet policy. Review the policy in Fireblocks or adjust the request.",
      cause: { code: "POLICY_REFUSED" },
    });
    if (!(refusal instanceof AppError)) throw new Error("Expected an AppError");
    expect(JSON.stringify(refusal.toResponse())).not.toContain("private provider text");
  });

  it.each([
    ["BLOCKED without a sub-status", { status: "BLOCKED" }],
    ["REJECTED", { status: "REJECTED", subStatus: "AUTO_FREEZE" }],
  ])("leaves %s to the provider's own failure", async (_case, poll) => {
    const signing = signAgainstPoll(poll);

    await expect(signing).rejects.not.toBeInstanceOf(AppError);
    await expect(signing).rejects.toThrow(`Transaction failed with status: ${poll.status}`);
  });
});
