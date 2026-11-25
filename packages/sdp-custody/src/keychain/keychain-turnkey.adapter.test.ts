import { createECDH } from "node:crypto";
import {
  AccountRole,
  appendTransactionMessageInstruction,
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
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { KeychainTurnkeyAdapter } from "./keychain-turnkey.adapter";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("turnkey adapter", () => {
  // The wallet co-signs behind another fee payer, so its signature is not in slot 0.
  it.each([
    ["32-byte scalar", "01".repeat(32)],
    ["leading-zero scalar", `00${"01".repeat(31)}`],
  ])(
    "signs a co-signed transaction's message bytes for the wallet's own signature (%s)",
    async (_label, privateKey) => {
      const wallet = await generateKeyPairSigner();
      const feePayer = await generateKeyPairSigner();
      const program = await generateKeyPairSigner();
      const transaction = compileTransaction(
        pipe(
          createTransactionMessage({ version: 0 }),
          (message) => setTransactionMessageFeePayer(feePayer.address, message),
          (message) =>
            setTransactionMessageLifetimeUsingBlockhash(
              {
                blockhash: blockhash("EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N"),
                lastValidBlockHeight: 1000n,
              },
              message
            ),
          (message) =>
            appendTransactionMessageInstruction(
              {
                programAddress: program.address,
                accounts: [{ address: wallet.address, role: AccountRole.READONLY_SIGNER }],
              },
              message
            )
        )
      );
      assertIsTransactionWithinSizeLimit(transaction);
      const [expected] = await wallet.signMessages([
        createSignableMessage(new Uint8Array(transaction.messageBytes)),
      ]);
      assert.isDefined(expected);
      const signature = Buffer.from(expected[wallet.address]);
      const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        Response.json({
          activity: {
            result: {
              signRawPayloadResult: {
                r: signature.subarray(0, 32).toString("hex"),
                s: signature.subarray(32).toString("hex"),
              },
            },
          },
        })
      );
      const apiKey = createECDH("prime256v1");
      apiKey.setPrivateKey(Buffer.from(privateKey, "hex"));
      const adapter = new KeychainTurnkeyAdapter({
        apiPublicKey: apiKey.getPublicKey("hex", "compressed"),
        // ECDH exports the scalar without leading zeroes; Turnkey needs all 32 bytes.
        apiPrivateKey: apiKey.getPrivateKey("hex").padStart(64, "0"),
        organizationId: "org-id",
        defaultWalletId: "turnkey_private-key-id",
        defaultWalletPublicKey: wallet.address,
      });

      const signer = await adapter.getTransactionSigner();
      const signatures = await signer.signTransactions([transaction]);

      expect(signatures).toEqual([{ [wallet.address]: expected[wallet.address] }]);
      expect(fetch).toHaveBeenCalledOnce();
      const call = fetch.mock.calls[0];
      assert.isDefined(call);
      const [url, init] = call;
      assert.isDefined(init);
      expect(String(url)).toBe("https://api.turnkey.com/public/v1/submit/sign_raw_payload");
      expect(JSON.parse(String(init.body))).toMatchObject({
        organizationId: "org-id",
        type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
        parameters: {
          encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
          hashFunction: "HASH_FUNCTION_NOT_APPLICABLE",
          payload: Buffer.from(transaction.messageBytes).toString("hex"),
          signWith: "private-key-id",
        },
      });
    }
  );
});
