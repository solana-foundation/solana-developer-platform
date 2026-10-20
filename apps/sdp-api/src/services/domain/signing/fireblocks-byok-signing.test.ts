import { generateKeyPairSync, sign } from "node:crypto";
import { isFullSigningPort } from "@sdp/custody/signing";
import { FireblocksSigner } from "@solana/keychain-fireblocks";
import {
  address,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase58Decoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { env as testEnv } from "@/test/helpers/env";
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

afterEach(() => vi.restoreAllMocks());

describe("Fireblocks BYOK transaction proposals", () => {
  it("uses solana-keychain RAW signing, waits for approval, verifies the signature and never broadcasts", async () => {
    const transaction = compileTransaction(
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
    const adapter = createFireblocksAdapterFromCredential(env, {
      apiKey: "tenant-key",
      apiSecretPem,
      assetId: "SOL_TEST",
      walletId: "fb_42",
    });
    if (!isFullSigningPort(adapter)) throw new Error("Expected signing adapter");
    const signer = await adapter.getTransactionSigner("fb_42", publicKey);
    expect(signer).toBeInstanceOf(FireblocksSigner);
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
