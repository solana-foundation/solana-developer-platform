import { normalizeUtilaWalletId } from "../provider-wallet-ids";
import { SigningError } from "../signing";
import type { KeychainUtilaConfig } from "./types";

type UtilaNetwork = "networks/solana-mainnet" | "networks/solana-devnet";

/**
 * Structural env slice consumed by the Utila keychain config builder. The API
 * app passes its full doppler-injected `Env`; only these fields are read here.
 */
export interface UtilaEnv {
  UTILA_SERVICE_ACCOUNT_EMAIL?: string;
  UTILA_SERVICE_ACCOUNT_PRIVATE_KEY?: string;
  UTILA_VAULT_ID?: string;
  UTILA_WALLET_ID?: string;
  UTILA_API_BASE_URL?: string;
  UTILA_POLL_INTERVAL_MS?: string;
  UTILA_MAX_POLL_ATTEMPTS?: string;
  UTILA_DESIGNATED_SIGNERS?: string;
}

interface BuildUtilaConfigOptions {
  apiBaseUrl?: string;
  defaultWalletId?: string | null;
  defaultWalletIdFromEnv?: boolean;
  missingMessage?: string;
  network: UtilaNetwork;
  vaultId?: string;
}

/**
 * Builds the Utila keychain config from the platform's Utila credentials and the
 * caller's network. The network is never read from the environment: the caller
 * passes the network of the cluster the wallet lives on.
 *
 * @param env - The Utila credential and tuning env slice.
 * @param options - Per-call overrides and the wallet's network.
 * @param options.apiBaseUrl - Overrides `UTILA_API_BASE_URL`.
 * @param options.defaultWalletId - The wallet the adapter signs with when none is named.
 * @param options.defaultWalletIdFromEnv - Reads the default wallet from `UTILA_WALLET_ID` when `defaultWalletId` is absent.
 * @param options.missingMessage - The error message when credentials or the vault are missing.
 * @param options.network - The Utila network resource of the wallet's cluster.
 * @param options.vaultId - Overrides `UTILA_VAULT_ID`.
 * @returns The keychain config.
 * @throws SigningError `PROVIDER_NOT_CONFIGURED` when credentials or the vault are missing.
 */
export function buildKeychainUtilaConfig(
  env: UtilaEnv,
  options: BuildUtilaConfigOptions
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
    network: options.network,
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
