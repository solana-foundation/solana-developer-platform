import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { generateEnv } from "./generate";
import { generateLocalSignerKeypair } from "./local-keypair";

const base58Pattern = /^[1-9A-HJ-NP-Za-km-z]+$/;

test("generateLocalSignerKeypair returns Solana-style base58 key material", async () => {
  const keypair = await generateLocalSignerKeypair();

  assert.match(keypair.publicKey, base58Pattern);
  assert.match(keypair.privateKey, base58Pattern);
  assert.ok(keypair.publicKey.length >= 32 && keypair.publicKey.length <= 44);
  assert.ok(keypair.privateKey.length >= 86 && keypair.privateKey.length <= 88);
});

test("generated local signer key can be emitted as CUSTODY_PRIVATE_KEY", async () => {
  const keypair = await generateLocalSignerKeypair();
  const env = generateEnv({
    SIGNING_PROVIDERS: "local",
    SIGNING_PROVIDER: "local",
    CUSTODY_PRIVATE_KEY: keypair.privateKey,
  });

  assert.match(env, new RegExp(`^CUSTODY_PRIVATE_KEY=${keypair.privateKey}$`, "m"));
});

test("generateLocalSignerKeypair preserves leading zero bytes in base58 output", async () => {
  await withMockedEd25519KeyMaterial(0, async () => {
    const keypair = await generateLocalSignerKeypair();

    assert.equal(keypair.publicKey, "1".repeat(32));
    assert.equal(keypair.privateKey, "1".repeat(64));
  });
});

test("generateLocalSignerKeypair encodes full-width key material", async () => {
  await withMockedEd25519KeyMaterial(255, async () => {
    const keypair = await generateLocalSignerKeypair();

    assert.match(keypair.publicKey, base58Pattern);
    assert.match(keypair.privateKey, base58Pattern);
    assert.equal(keypair.publicKey.length, 44);
    assert.equal(keypair.privateKey.length, 88);
  });
});

async function withMockedEd25519KeyMaterial(byte: number, run: () => Promise<void>): Promise<void> {
  const originalCrypto = crypto;
  const privateKey = {} as CryptoKey;
  const publicKey = {} as CryptoKey;
  const jwkValue = Buffer.from(new Uint8Array(32).fill(byte)).toString("base64url");

  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      subtle: {
        async generateKey() {
          return { privateKey, publicKey };
        },
        async exportKey(_format: string, key: CryptoKey) {
          return key === privateKey
            ? { kty: "OKP", crv: "Ed25519", d: jwkValue, x: jwkValue }
            : { kty: "OKP", crv: "Ed25519", x: jwkValue };
        },
      },
    },
  });

  try {
    await run();
  } finally {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: originalCrypto,
    });
  }
}
