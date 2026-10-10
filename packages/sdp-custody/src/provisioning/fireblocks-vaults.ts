import { SigningError } from "../signing";
import { assertHttpsBaseUrl } from "./common";
import { fireblocksRequest } from "./fireblocks-http";
import type { CustodyProvisioningRuntime } from "./runtime";

export interface FireblocksVault {
  id: string;
  name: string;
  hasSolanaWallet: boolean;
}
export interface FireblocksVaultPage {
  vaults: FireblocksVault[];
  nextCursor: string | null;
}
interface VaultAccess {
  apiKey: string;
  apiSecretPem: string;
  apiBaseUrl?: string;
  assetId: "SOL" | "SOL_TEST";
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SigningError("Invalid Fireblocks vault response", "PROVIDER_NOT_CONFIGURED");
  return value as Record<string, unknown>;
}
function vault(value: unknown, assetId: string): FireblocksVault {
  const item = record(value);
  if (
    typeof item.id !== "string" ||
    !/^\d{1,100}$/.test(item.id) ||
    typeof item.name !== "string" ||
    !Array.isArray(item.assets)
  )
    throw new SigningError("Invalid Fireblocks vault response", "PROVIDER_NOT_CONFIGURED");
  return {
    id: item.id,
    name: item.name.trim().slice(0, 256) || `Vault ${item.id}`,
    hasSolanaWallet: item.assets.some((asset: unknown) => record(asset).id === assetId),
  };
}
function requestConfig(config: VaultAccess) {
  return {
    apiBaseUrl: assertHttpsBaseUrl(config.apiBaseUrl ?? "https://api.fireblocks.io", "Fireblocks"),
    apiKey: config.apiKey,
    apiSecretPem: config.apiSecretPem,
    method: "GET" as const,
  };
}

/** One bounded provider read. Never follow provider-supplied pagination URLs. */
export async function listFireblocksVaults(
  runtime: CustodyProvisioningRuntime,
  config: VaultAccess,
  options: { after?: string; namePrefix?: string } = {}
): Promise<FireblocksVaultPage> {
  const query = new URLSearchParams({ limit: "50", assetId: config.assetId });
  if (options.after) query.set("after", options.after);
  if (options.namePrefix) query.set("namePrefix", options.namePrefix);
  const result = record(
    await fireblocksRequest<unknown>(runtime, {
      ...requestConfig(config),
      uri: `/v1/vault/accounts_paged?${query}`,
    })
  );
  if (!Array.isArray(result.accounts) || result.accounts.length > 50)
    throw new SigningError("Invalid Fireblocks vault page", "PROVIDER_NOT_CONFIGURED");
  const after = result.paging == null ? undefined : record(result.paging).after;
  if (after != null && (typeof after !== "string" || after.length > 512))
    throw new SigningError("Invalid Fireblocks pagination cursor", "PROVIDER_NOT_CONFIGURED");
  return {
    vaults: result.accounts
      .map((item) => vault(item, config.assetId))
      .filter((item) => item.hasSolanaWallet),
    nextCursor:
      typeof after === "string" && after.length > 0 && after !== options.after ? after : null,
  };
}

/** Confirm the selected vault's current name and network before importing it. */
export async function getFireblocksVault(
  runtime: CustodyProvisioningRuntime,
  config: VaultAccess,
  id: string
): Promise<FireblocksVault> {
  if (!/^\d{1,100}$/.test(id))
    throw new SigningError("Invalid vault ID", "PROVIDER_NOT_CONFIGURED");
  const result = vault(
    await fireblocksRequest<unknown>(runtime, {
      ...requestConfig(config),
      uri: `/v1/vault/accounts/${id}`,
    }),
    config.assetId
  );
  if (result.id !== id) throw new SigningError("Fireblocks vault identity mismatch", "CONFLICT");
  return result;
}
