import { normalizeUtilaWalletId } from "@/services/domain/signing/provider-wallet-ids";
import { SigningError } from "@/services/ports";
import type { Env } from "@/types/env";
import type { KeychainUtilaConfig } from "./types";

type UtilaNetwork = "networks/solana-mainnet" | "networks/solana-devnet";

interface BuildUtilaConfigOptions {
  apiBaseUrl?: string;
  defaultWalletId?: string | null;
  defaultWalletIdFromEnv?: boolean;
  missingMessage?: string;
  network?: UtilaNetwork;
  vaultId?: string;
}

export function buildKeychainUtilaConfig(
  env: Env,
  options: BuildUtilaConfigOptions = {}
): KeychainUtilaConfig {
  const serviceAccountEmail = env.UTILA_SERVICE_ACCOUNT_EMAIL;
  const serviceAccountPrivateKeyPem = env.UTILA_SERVICE_ACCOUNT_PRIVATE_KEY;
  const vaultId = options.vaultId ?? env.UTILA_VAULT_ID;

  if (!serviceAccountEmail || !serviceAccountPrivateKeyPem || !vaultId) {
    throw new SigningError(
      options.missingMessage ??
        "Utila configuration is missing service account credentials or vault ID",
      "PROVIDER_NOT_CONFIGURED"
    );
  }

  const defaultWalletId =
    options.defaultWalletId ?? (options.defaultWalletIdFromEnv ? env.UTILA_WALLET_ID : undefined);

  return {
    serviceAccountEmail,
    serviceAccountPrivateKeyPem,
    vaultId,
    network: resolveUtilaNetwork(env, options.network),
    apiBaseUrl: options.apiBaseUrl ?? env.UTILA_API_BASE_URL,
    pollIntervalMs: parseOptionalPositiveInteger(
      env.UTILA_POLL_INTERVAL_MS,
      "UTILA_POLL_INTERVAL_MS"
    ),
    maxPollAttempts: parseOptionalPositiveInteger(
      env.UTILA_MAX_POLL_ATTEMPTS,
      "UTILA_MAX_POLL_ATTEMPTS"
    ),
    designatedSigners: parseCsvList(env.UTILA_DESIGNATED_SIGNERS),
    defaultWalletId: defaultWalletId ? normalizeUtilaWalletId(defaultWalletId) : undefined,
  };
}

function resolveUtilaNetwork(env: Env, configured?: UtilaNetwork): UtilaNetwork {
  if (configured) {
    return configured;
  }
  if (env.UTILA_NETWORK) {
    return env.UTILA_NETWORK;
  }
  return env.SOLANA_NETWORK === "mainnet-beta"
    ? "networks/solana-mainnet"
    : "networks/solana-devnet";
}

function parseOptionalPositiveInteger(
  value: string | undefined,
  envVarName: string
): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new SigningError(`${envVarName} must be a positive integer`, "INVALID_REQUEST");
  }
  return parsed;
}

function parseCsvList(value: string | undefined): string[] | undefined {
  const items = value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items && items.length > 0 ? items : undefined;
}
