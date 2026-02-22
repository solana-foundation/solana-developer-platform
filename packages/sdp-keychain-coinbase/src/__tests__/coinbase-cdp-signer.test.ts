import { getBase58Codec } from "@solana/codecs";
import { createSignableMessage } from "@solana/signers";
import { describe, expect, it, vi } from "vitest";
import { CoinbaseCdpSigner } from "../coinbase-cdp-signer.js";

describe("CDP signer", () => {
  it("fails create() when required config is missing", async () => {
    await expect(
      CoinbaseCdpSigner.create({
        apiKeyId: "",
        apiKeySecret: "",
        walletSecret: "",
        walletId: "",
      })
    ).rejects.toThrowError(/Missing required configuration fields/i);
  });

  it("parses base58 signature responses into signature bytes when signing messages", async () => {
    const base58 = getBase58Codec();
    const keyMaterial = await createEs256KeyMaterial();
    const walletAddress = base58.decode(Uint8Array.from({ length: 32 }, (_, index) => index + 1));
    const expectedSignatureBytes = Uint8Array.from({ length: 64 }, (_, index) => index + 1);
    const signatureBase58 = base58.decode(expectedSignatureBytes);

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

        if (url.includes(`/v2/solana/accounts/${walletAddress}`) && init?.method === "GET") {
          return new Response(JSON.stringify({ address: walletAddress }), {
            headers: { "Content-Type": "application/json" },
            status: 200,
          });
        }

        if (
          url.includes(`/v2/solana/accounts/${walletAddress}/sign/message`) &&
          init?.method === "POST"
        ) {
          return new Response(JSON.stringify({ signature: signatureBase58 }), {
            headers: { "Content-Type": "application/json" },
            status: 200,
          });
        }

        throw new Error(`Unexpected fetch call: ${init?.method ?? "GET"} ${url}`);
      });

    try {
      const signer = await CoinbaseCdpSigner.create({
        apiKeyId: "test-api-key-id",
        apiKeySecret: keyMaterial.privateKeyPem,
        walletId: walletAddress,
        walletSecret: keyMaterial.privateKeyPkcs8Base64,
      });

      const [signatureDictionary] = await signer.signMessages([createSignableMessage("hello cdp")]);
      expect(Object.keys(signatureDictionary)).toContain(signer.address);

      const actualSignature = Object.values(signatureDictionary)[0] as Uint8Array | undefined;
      expect(actualSignature).toBeDefined();
      expect(Array.from(actualSignature ?? [])).toEqual(Array.from(expectedSignatureBytes));
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      fetchMock.mockRestore();
    }
  });
});

async function createEs256KeyMaterial(): Promise<{
  privateKeyPem: string;
  privateKeyPkcs8Base64: string;
}> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "ECDSA",
      namedCurve: "P-256",
    },
    true,
    ["sign", "verify"]
  );

  const pkcs8Bytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
  const privateKeyPkcs8Base64 = Buffer.from(pkcs8Bytes).toString("base64");
  const pemLines = privateKeyPkcs8Base64.match(/.{1,64}/g)?.join("\n") ?? privateKeyPkcs8Base64;
  const privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${pemLines}\n-----END PRIVATE KEY-----`;

  return {
    privateKeyPem,
    privateKeyPkcs8Base64,
  };
}
