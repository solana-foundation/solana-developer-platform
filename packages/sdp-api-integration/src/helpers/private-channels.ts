/**
 * Solana Private Channels (SPC) — integration test helpers.
 *
 * App-free (imports only `#env-impl`), so the gateway connectivity suite doesn't
 * drag the SDP app into its module graph. The live sandbox gateway URL is read
 * straight from the test env: the app resolves each project's connection from its
 * persisted record, but a live-endpoint test legitimately targets a URL from its
 * environment.
 *
 * Run (with the gateway reachable):
 *   RUN_INTEGRATION_TESTS=true \
 *   PRIVATE_CHANNEL_GATEWAY_URL=http://34.71.147.163:8899 \
 *     pnpm --filter @sdp/api-integration test
 */

import { env } from "#env-impl";

export const RUN_INTEGRATION_TESTS = env.RUN_INTEGRATION_TESTS === "true";

function readEnv(key: string): string {
  const value = (env as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

const GATEWAY_URL = readEnv("PRIVATE_CHANNEL_GATEWAY_URL");

export const PRIVATE_CHANNEL_CONFIGURED = GATEWAY_URL.length > 0;

/** The live SPC gateway base URL under test. */
export function getGatewayUrl(): string {
  return GATEWAY_URL;
}

// ── Full-flow canary config ────────────────────────────────────────────────

const CHAIN_RPC_URL = readEnv("PRIVATE_CHANNEL_CHAIN_RPC_URL");
const DEPOSIT_SECRET_KEY = readEnv("PRIVATE_CHANNEL_DEPOSIT_SECRET_KEY");
const RECIPIENT_SECRET_KEY = readEnv("PRIVATE_CHANNEL_RECIPIENT_SECRET_KEY");
const ESCROW_INSTANCE_ID = readEnv("PRIVATE_CHANNEL_ESCROW_INSTANCE_ID");
const AUTH_URL = readEnv("PRIVATE_CHANNEL_AUTH_URL");
const AUTH_USERNAME = readEnv("PRIVATE_CHANNEL_AUTH_USERNAME");
const AUTH_PASSWORD = readEnv("PRIVATE_CHANNEL_AUTH_PASSWORD");

/**
 * The live full-flow test needs two wallets, auth credentials, an escrow instance,
 * and both gateway and devnet RPC endpoints. Ordinary integration runs only need
 * the gateway, so the transaction canary skips unless every secret is present.
 */
export const PRIVATE_CHANNEL_FULL_FLOW_CONFIGURED =
  PRIVATE_CHANNEL_CONFIGURED &&
  CHAIN_RPC_URL.length > 0 &&
  DEPOSIT_SECRET_KEY.length > 0 &&
  RECIPIENT_SECRET_KEY.length > 0 &&
  ESCROW_INSTANCE_ID.length > 0 &&
  AUTH_URL.length > 0 &&
  AUTH_USERNAME.length > 0 &&
  AUTH_PASSWORD.length > 0;

/** Devnet chain RPC the escrow deposit broadcasts to. */
export function getChainRpcUrl(): string {
  return CHAIN_RPC_URL;
}

/** The funded devnet keypair secret (`[..64 numbers..]` JSON array or base58). */
export function getDepositSecretKey(): string {
  return DEPOSIT_SECRET_KEY;
}

/** A second funded-capable wallet used to prove transfer and withdrawal. */
export function getRecipientSecretKey(): string {
  return RECIPIENT_SECRET_KEY;
}

/** Escrow instance created by the protected devnet bootstrap workflow. */
export function getEscrowInstanceId(): string {
  return ESCROW_INSTANCE_ID;
}

export function getAuthUrl(): string {
  return AUTH_URL;
}

export function getAuthUsername(): string {
  return AUTH_USERNAME;
}

export function getAuthPassword(): string {
  return AUTH_PASSWORD;
}

/** Base-unit deposit amount for the live test (default 0.01 USDC). */
export function getDepositAmountBaseUnits(): bigint {
  const raw = readEnv("PRIVATE_CHANNEL_DEPOSIT_AMOUNT_BASE_UNITS");
  return raw ? BigInt(raw) : 10_000n;
}
