import type { CoinbaseCdpSignerConfig } from "../coinbase-cdp-signer.js";

const REQUIRED_ENV_VARS = [
  "COINBASE_CDP_API_KEY_ID",
  "COINBASE_CDP_API_KEY_SECRET",
  "COINBASE_CDP_WALLET_SECRET",
  "COINBASE_CDP_WALLET_ID",
] as const;

export function hasRequiredEnvVars(): boolean {
  return REQUIRED_ENV_VARS.every((key) => Boolean(process.env[key]));
}

export function getConfig(): CoinbaseCdpSignerConfig {
  return {
    apiKeyId: process.env.COINBASE_CDP_API_KEY_ID ?? "",
    apiKeySecret: process.env.COINBASE_CDP_API_KEY_SECRET ?? "",
    walletSecret: process.env.COINBASE_CDP_WALLET_SECRET ?? "",
    walletId: process.env.COINBASE_CDP_WALLET_ID ?? "",
    apiBaseUrl: process.env.COINBASE_CDP_API_BASE_URL,
    requestDelayMs: parseOptionalNumber(process.env.COINBASE_CDP_REQUEST_DELAY_MS),
  };
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
