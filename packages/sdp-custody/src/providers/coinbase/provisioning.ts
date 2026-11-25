import { assertHttpsBaseUrl } from "#/shared/common";
import type { CustodyProvisioningRuntime } from "#/shared/runtime";
import { SigningError } from "#/signing";
import {
  coinbaseCdpRequest,
  deriveCoinbaseCdpAccountName,
  extractCoinbaseCdpAccountAddress,
  isCoinbaseCdpAlreadyExistsError,
} from "./api";

const DEFAULT_COINBASE_CDP_API_BASE_URL = "https://api.cdp.coinbase.com/platform";
const DEFAULT_COINBASE_CDP_NETWORK = "solana-devnet";

interface CoinbaseCdpSolanaAccountResponse {
  address: string;
  name?: string;
}

export interface ProvisionCoinbaseCdpOptions {
  orgId: string;
  /** null/undefined designates the organization-level scope. */
  projectId?: string | null;
  /**
   * Unique seed for additional wallets beyond the scope's root account.
   * Omitted for the root account so retries resolve to the same slot.
   */
  walletSeed?: string;
  /**
   * Allow resolving a 409 name collision to the existing account. Only safe
   * for deterministic identities (root account retries); the derived name
   * encodes the full tenant scope, so the existing account can only belong to
   * the same scope. Defaults to false: collisions fail instead of silently
   * handing out an existing account.
   */
  reuseExisting?: boolean;
  accountPolicy?: string;
  /**
   * Sent as CDP's `X-Idempotency-Key`, so a retried create is answered with
   * the account the first attempt made. A fresh UUID when omitted.
   */
  idempotencyKey?: string;
}

export interface CoinbaseCdpProvisioningConfig {
  apiKeyId?: string;
  apiKeySecret?: string;
  walletSecret?: string;
  apiBaseUrl?: string;
  network?: "solana" | "solana-devnet";
  accountScope?: string;
}

export interface ProvisionCoinbaseCdpResult {
  address: string;
  network: "solana" | "solana-devnet";
}

export async function provisionCoinbaseCdpAccount(
  runtime: CustodyProvisioningRuntime,
  config: CoinbaseCdpProvisioningConfig,
  options: ProvisionCoinbaseCdpOptions
): Promise<ProvisionCoinbaseCdpResult> {
  const apiKeyId = config.apiKeyId;
  const apiKeySecret = config.apiKeySecret;
  const walletSecret = config.walletSecret;

  if (!apiKeyId || !apiKeySecret || !walletSecret) {
    throw new SigningError(
      "Coinbase CDP environment variables not configured: COINBASE_CDP_API_KEY_ID, COINBASE_CDP_API_KEY_SECRET, COINBASE_CDP_WALLET_SECRET",
      "PROVIDER_NOT_CONFIGURED"
    );
  }

  const apiBaseUrl = assertHttpsBaseUrl(
    config.apiBaseUrl ?? DEFAULT_COINBASE_CDP_API_BASE_URL,
    "Coinbase CDP"
  );
  const network = config.network ?? DEFAULT_COINBASE_CDP_NETWORK;

  const name = await deriveCoinbaseCdpAccountName(runtime, {
    accountScope: config.accountScope,
    organizationId: options.orgId,
    projectId: options.projectId,
    network,
    walletSeed: options.walletSeed,
  });

  try {
    const created = await coinbaseCdpRequest<CoinbaseCdpSolanaAccountResponse>(runtime, {
      method: "POST",
      path: "/v2/solana/accounts",
      apiBaseUrl,
      apiKeyId,
      apiKeySecret,
      walletSecret,
      idempotencyKey: options.idempotencyKey ?? runtime.randomUUID(),
      body: {
        name,
        ...(options.accountPolicy ? { accountPolicy: options.accountPolicy } : {}),
      },
    });

    const createdAddress = extractCoinbaseCdpAccountAddress(created);
    if (!createdAddress) {
      throw new SigningError("Coinbase CDP wallet creation failed", "PROVIDER_NOT_CONFIGURED");
    }

    return { address: createdAddress, network };
  } catch (error) {
    if (!isCoinbaseCdpAlreadyExistsError(error)) {
      throw error;
    }

    if (!options.reuseExisting) {
      throw new SigningError(
        `Coinbase CDP account '${name}' already exists and this operation does not reuse existing accounts`,
        "PROVIDER_NOT_CONFIGURED",
        error
      );
    }

    try {
      const existingByName = await coinbaseCdpRequest<CoinbaseCdpSolanaAccountResponse>(runtime, {
        method: "GET",
        path: `/v2/solana/accounts/by-name/${encodeURIComponent(name)}`,
        apiBaseUrl,
        apiKeyId,
        apiKeySecret,
        walletSecret,
      });

      const existingAddressByName = extractCoinbaseCdpAccountAddress(existingByName);
      if (existingAddressByName) {
        return { address: existingAddressByName, network };
      }

      throw new SigningError(
        `Coinbase CDP account '${name}' already exists but lookup by name returned no address. Provide walletAddress to reuse the account.`,
        "PROVIDER_NOT_CONFIGURED"
      );
    } catch (lookupError) {
      if (lookupError instanceof SigningError && !isCoinbaseCdpAlreadyExistsError(lookupError)) {
        throw new SigningError(
          `Coinbase CDP account '${name}' already exists but could not be resolved by name. Provide walletAddress to reuse the account.`,
          "PROVIDER_NOT_CONFIGURED",
          lookupError
        );
      }

      throw lookupError;
    }
  }
}
