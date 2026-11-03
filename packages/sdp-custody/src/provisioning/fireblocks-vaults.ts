import { z } from "zod";
import { SigningError } from "#/signing";
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

const vaultSchema = z.object({
  id: z.string().regex(/^\d{1,100}$/),
  name: z.string(),
  assets: z.array(z.object({ id: z.string() })),
});
const pageSchema = z.object({
  accounts: z.array(vaultSchema).max(50),
  paging: z.object({ after: z.string().max(512).nullish() }).nullish(),
});
function vault(value: unknown, assetId: string): FireblocksVault {
  const parsed = vaultSchema.safeParse(value);
  if (!parsed.success)
    throw new SigningError("Invalid Fireblocks vault response", "PROVIDER_NOT_CONFIGURED");
  const item = parsed.data;
  return {
    id: item.id,
    name: item.name.trim().slice(0, 256) || `Vault ${item.id}`,
    hasSolanaWallet: item.assets.some((asset) => asset.id === assetId),
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
  const parsed = pageSchema.safeParse(
    await fireblocksRequest<unknown>(runtime, {
      ...requestConfig(config),
      uri: `/v1/vault/accounts_paged?${query}`,
    })
  );
  if (!parsed.success)
    throw new SigningError("Invalid Fireblocks vault page", "PROVIDER_NOT_CONFIGURED");
  const result = parsed.data;
  const after = result.paging?.after;
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
