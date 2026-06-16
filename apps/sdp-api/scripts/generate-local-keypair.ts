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
import { generateLocalSignerKeypair, generateSecret } from "@sdp/env-config";

const quiet = process.argv.includes("--quiet");

const keypair = await generateLocalSignerKeypair();
const encryptionKey = generateSecret("CUSTODY_ENCRYPTION_KEY");

if (quiet) {
  process.stdout.write(keypair.privateKey);
} else {
  console.log(`PUBLIC_KEY=${keypair.publicKey}`);
  console.log(`CUSTODY_PRIVATE_KEY=${keypair.privateKey}`);
  console.log(
    `# FEE_PAYER_PRIVATE_KEY=${keypair.privateKey}  # uncomment for local dev; use a distinct keypair in production`
  );
  console.log(`CUSTODY_ENCRYPTION_KEY=${encryptionKey}`);
}
