import assert from "node:assert/strict";
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
