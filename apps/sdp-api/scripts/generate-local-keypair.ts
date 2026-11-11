#!/usr/bin/env -S tsx
/**
 * Generate the secrets a self-hosted SDP API needs in .env.local:
 *   - CUSTODY_PRIVATE_KEY    (Solana 64-byte keypair, base58-encoded)
 *   - CUSTODY_ENCRYPTION_KEY (256-bit AES key, base64-encoded)
 *
 * Setting CUSTODY_PRIVATE_KEY turns the local signer on: the API only checks
 * that it is set, and each project's local signer makes its own keypair. The
 * value is still a well-formed keypair (32B seed + 32B public key, base58).
 * The encryption key is required by EncryptionService for storing
 * provider-managed wallet secrets when connecting custody providers
 * through the dashboard.
 *
 * Usage:
 *   pnpm --filter @sdp/api keygen:local
 *   pnpm --filter @sdp/api keygen:local --quiet   # private key only, for piping
 */
import { generateLocalSignerKeypair } from "@sdp/env-config/local-keypair";
import { generateSecret } from "@sdp/env-config/secrets";

const quiet = process.argv.includes("--quiet");

const keypair = await generateLocalSignerKeypair();
const encryptionKey = generateSecret("CUSTODY_ENCRYPTION_KEY");

if (quiet) {
  process.stdout.write(keypair.privateKey);
} else {
  console.log(`PUBLIC_KEY=${keypair.publicKey}`);
  console.log(`CUSTODY_PRIVATE_KEY=${keypair.privateKey}`);
  console.log(`CUSTODY_ENCRYPTION_KEY=${encryptionKey}`);
}
