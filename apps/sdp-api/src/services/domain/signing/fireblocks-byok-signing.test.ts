import { generateKeyPairSync, sign } from "node:crypto";
import { isFullSigningPort } from "@sdp/custody/signing";
import type { EarnVaultTransactionPlan } from "@sdp/earn/types";
import type { FeePaymentPort } from "@sdp/fee-payment/port";
import {
  address,
  blockhash,
  compileTransaction,
  createSignableMessage,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  isFullySignedTransaction,
  isMessagePartialSigner,
  isTransactionPartialSigner,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { afterEach, aroundEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AppError } from "@/lib/errors";
import { isEarnEnabled } from "@/lib/feature-flags";
import { createVaultDeadline } from "@/services/earn/vault-deadline";
import { signVaultPlan } from "@/services/earn/vault-execution.service";
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

const proposalSchema = z.object({
  operation: z.literal("PROGRAM_CALL"),
  extraParameters: z.object({
    programCallData: z.string(),
    signOnly: z.literal(true),
    useDurableNonce: z.literal(false),
  }),
});

afterEach(() => vi.restoreAllMocks());
aroundEach((runTest) => inSandboxScope(runTest));

function testTransaction() {
  return compileTransaction(
    pipe(
      createTransactionMessage({ version: 0 }),
      (message) => setTransactionMessageFeePayer(publicKey, message),
      (message) =>
        setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash: blockhash("11111111111111111111111111111111"),
            lastValidBlockHeight: 100n,
          },
          message
        )
    )
  );
}

describe("Fireblocks BYOK transaction proposals", () => {
  it.each(["beta", "experimental"])(
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
      expect(isEarnEnabled(releaseEnv)).toBe(true);
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
      });
    const adapter = createFireblocksAdapterFromCredential(env, CREDENTIAL);
    if (!isFullSigningPort(adapter)) throw new Error("Expected full signing port");
    const signer = await adapter.getTransactionSigner();
    if (!isTransactionPartialSigner(signer)) throw new Error("Expected partial signer");
    await expect(
      signer.signTransactions([testTransaction()], {
        abortSignal: controller.signal,
      })
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("refuses stable before reading credentials or proposing anything", () => {
    const stable = { ...env, SDP_RELEASE_CHANNEL: "stable" };
    const read = vi.fn(() => "must not read");
    const fetch = vi.spyOn(globalThis, "fetch");
    expect(isEarnEnabled(stable)).toBe(false);
    expect(() =>
      createFireblocksAdapterFromCredential(stable, {
        ...CREDENTIAL,
        get apiKey() {
          return read();
        },
      })
    ).toThrow();
    expect(read).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
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

describe("Earn execution through Fireblocks BYOK", () => {
  it.each(["deposit", "withdrawal"] as const)(
    "signs an Earn %s with either the wallet or a separate fee sponsor",
    async (operation) => {
      const sponsor = await generateKeyPairSigner();
      const plan: EarnVaultTransactionPlan = {
        cluster: "devnet",
        assetIdentity: { depositTokenMint: publicKey, shareMint: sponsor.address },
        lookupTables: [],
        instructions: [
          {
            programAddress: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
            accounts: [{ address: publicKey, role: 2 }],
            data: Buffer.from(`earn ${operation}`).toString("base64"),
          },
        ],
      };
      const lifetime = {
        blockhash: blockhash("11111111111111111111111111111111"),
        lastValidBlockHeight: 100n,
      };
      for (const sponsored of [false, true]) {
        let proposalMessage: Uint8Array | undefined;
        const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
          if (String(url).endsWith("addresses_paginated"))
            return Response.json({ addresses: [{ address: publicKey }] });
          if (init?.method === "POST") {
            const proposal = proposalSchema.parse(JSON.parse(String(init.body)));
            expect(proposal).toMatchObject({
              operation: "PROGRAM_CALL",
              extraParameters: {
                signOnly: true,
                useDurableNonce: false,
              },
            });
            const transaction = getTransactionDecoder().decode(
              Buffer.from(proposal.extraParameters.programCallData, "base64")
            );
            proposalMessage = new Uint8Array(transaction.messageBytes);
            return Response.json({ id: "earn-proposal", status: "SUBMITTED" });
          }
          if (proposalMessage === undefined) throw new Error("Polled before proposing");
          return Response.json({
            id: "earn-proposal",
            status: "SIGNED",
            signedMessages: [
              {
                signature: {
                  fullSig: sign(null, proposalMessage, ed25519.privateKey).toString("hex"),
                },
              },
            ],
          });
        });
        const adapter = createFireblocksAdapterFromCredential(env, CREDENTIAL);
        if (!isFullSigningPort(adapter)) throw new Error("Expected full signing port");
        const feePayment: FeePaymentPort = {
          providerId: "test",
          getFeePayer: vi.fn(),
          getSponsorshipConfiguration: vi.fn(),
          signAsFeePayer: vi.fn(async (bytes) => {
            const transaction = getTransactionDecoder().decode(bytes);
            expect(transaction.signatures[publicKey]).not.toBeNull();
            const signed = await partiallySignTransaction([sponsor.keyPair], transaction);
            return new Uint8Array(getTransactionEncoder().encode(signed));
          }),
        };
        const signed = await signVaultPlan({
          plan,
          expectedAssetIdentity: plan.assetIdentity,
          owner: await adapter.getTransactionSigner("fb_42"),
          deadline: createVaultDeadline(),
          prepared: { plan, lookupTables: {}, ...lifetime },
          fee: sponsored
            ? { kind: "sponsored", feePayment, sponsor: sponsor.address }
            : { kind: "wallet-pays" },
        });
        const transaction = getTransactionDecoder().decode(signed.bytes);
        expect(new Uint8Array(transaction.messageBytes)).toEqual(proposalMessage);
        expect(isFullySignedTransaction(transaction)).toBe(true);
        expect(Object.keys(transaction.signatures)).toEqual(
          sponsored ? [sponsor.address, publicKey] : [publicKey]
        );
        expect(feePayment.signAsFeePayer).toHaveBeenCalledTimes(sponsored ? 1 : 0);
        expect(feePayment.getFeePayer).not.toHaveBeenCalled();
        expect(fetch).toHaveBeenCalledTimes(3);
        fetch.mockRestore();
      }
    }
  );
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
