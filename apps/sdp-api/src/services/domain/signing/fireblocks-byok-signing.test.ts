import { generateKeyPairSync, sign } from "node:crypto";
import { isFullSigningPort } from "@sdp/custody/signing";
import {
  address,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase58Decoder,
  isTransactionPartialSigner,
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
  it("uses solana-keychain RAW signing, waits for approval, verifies the signature and never broadcasts", async () => {
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
          status: "COMPLETED",
          signedMessages: [{ signature: { fullSig: signature.toString("hex") } }],
        })
      );
    const adapter = createFireblocksAdapterFromCredential(env, CREDENTIAL);
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
      operation: "RAW",
      assetId: "SOL_TEST",
      source: { type: "VAULT_ACCOUNT", id: "42" },
      extraParameters: {
        rawMessageData: {
          messages: [{ content: Buffer.from(transaction.messageBytes).toString("hex") }],
        },
      },
    });
    for (const [url, init] of fetch.mock.calls) {
      expect(String(url).startsWith(env.FIREBLOCKS_API_BASE_URL)).toBe(true);
      expect(new Headers(init?.headers).get("X-API-Key")).toBe("tenant-key");
    }
    expect(await adapter.getTransactionSigner("fb_42", publicKey)).toBe(signer);
    expect(fetch).toHaveBeenCalledTimes(4);
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
