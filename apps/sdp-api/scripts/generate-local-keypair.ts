#!/usr/bin/env -S tsx
/**
 * Generate the secrets a self-hosted SDP API needs in .dev.vars:
 *   - CUSTODY_PRIVATE_KEY    (Solana 64-byte keypair, base58-encoded)
 *   - CUSTODY_ENCRYPTION_KEY (256-bit AES key, base64-encoded)
 *
 * Verbose output also includes a commented FEE_PAYER_PRIVATE_KEY hint:
 * the same keypair can serve both roles in local dev (uncomment to use it),
 * but distinct keys are recommended for any non-dev deployment.
 *
 * The keypair format matches what KeychainMemoryAdapter (the runtime
 * adapter for SIGNING_PROVIDER=local) and NativeFeePaymentAdapter expect
 * (32B seed + 32B public key, base58-encoded).
 * The encryption key is required by EncryptionService for storing
 * provider-managed wallet secrets when connecting custody providers
 * through the dashboard.
 *
 * Usage:
 *   pnpm --filter @sdp/api keygen:local
 *   pnpm --filter @sdp/api keygen:local --quiet   # private key only, for piping
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { getBase58Codec } from "@solana/codecs";

interface Ed25519Jwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  d?: string;
}

const quiet = process.argv.includes("--quiet");

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pubJwk = publicKey.export({ format: "jwk" }) as Ed25519Jwk;
const privJwk = privateKey.export({ format: "jwk" }) as Ed25519Jwk;

if (!privJwk.d) {
  throw new Error("private key JWK is missing the 'd' field");
}

const seed = Buffer.from(privJwk.d, "base64url");
const pub = Buffer.from(pubJwk.x, "base64url");

if (seed.length !== 32 || pub.length !== 32) {
  throw new Error(`unexpected key sizes: seed=${seed.length} pub=${pub.length}`);
}

const secretKey = new Uint8Array(64);
secretKey.set(seed, 0);
secretKey.set(pub, 32);

const codec = getBase58Codec();
const secretBase58 = codec.decode(secretKey);
const pubBase58 = codec.decode(new Uint8Array(pub));

const encryptionKey = randomBytes(32).toString("base64");

if (quiet) {
  process.stdout.write(secretBase58);
} else {
  console.log(`PUBLIC_KEY=${pubBase58}`);
  console.log(`CUSTODY_PRIVATE_KEY=${secretBase58}`);
  console.log(
    `# FEE_PAYER_PRIVATE_KEY=${secretBase58}  # uncomment for local dev; use a distinct keypair in production`
  );
  console.log(`CUSTODY_ENCRYPTION_KEY=${encryptionKey}`);
}
