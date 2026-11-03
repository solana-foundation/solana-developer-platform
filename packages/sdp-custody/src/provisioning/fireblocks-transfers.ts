import { z } from "zod";
import { SigningError } from "#/signing";
import { assertHttpsBaseUrl } from "./common";
import { FireblocksApiError, fireblocksRequest } from "./fireblocks-http";
import type { CustodyProvisioningRuntime } from "./runtime";

export interface FireblocksTransferAccess {
  apiKey: string;
  apiSecretPem: string;
  apiBaseUrl?: string;
}

export interface FireblocksTransferRequest {
  operation: "TRANSFER";
  externalTxId: string;
  assetId: string;
  source: { type: "VAULT_ACCOUNT"; id: string };
  destination: { type: "ONE_TIME_ADDRESS"; oneTimeAddress: { address: string } };
  amount: string;
  treatAsGrossAmount: false;
  note: string;
}

const optionalText = z
  .string()
  .max(256)
  .nullish()
  .transform((value) => value ?? undefined);
const optionalAmount = z
  .string()
  .max(100)
  .regex(/^\d+(\.\d+)?$/)
  .nullish()
  .transform((value) => value ?? undefined);
const transferResultSchema = z.object({
  id: z.string().min(1).max(256),
  status: z.string().regex(/^[A-Z_]{1,100}$/),
  subStatus: optionalText,
  txHash: optionalText,
  externalTxId: optionalText,
  operation: optionalText,
  assetId: optionalText,
  source: z
    .object({ type: z.string().max(256), id: z.string().max(256) })
    .nullish()
    .transform((value) => value ?? undefined),
  destinationAddress: optionalText,
  amountInfo: z
    .object({ amount: optionalAmount, requestedAmount: optionalAmount, netAmount: optionalAmount })
    .nullish()
    .transform((value) => value ?? undefined),
  feeCurrency: optionalText,
  feeInfo: z
    .object({ networkFee: optionalAmount })
    .nullish()
    .transform((value) => value ?? undefined),
});
export type FireblocksTransferResult = z.infer<typeof transferResultSchema>;
const assetSchema = z.object({
  id: z.string().min(1).max(256),
  type: z.string(),
  nativeAsset: optionalText,
  issuerAddress: optionalText,
  decimals: z.number().int().min(0).max(255).optional(),
});
type Asset = z.infer<typeof assetSchema>;
const catalogues = new Map<string, { expires: number; value: Promise<Asset[]> }>();

function config(access: FireblocksTransferAccess) {
  return {
    ...access,
    apiBaseUrl: assertHttpsBaseUrl(access.apiBaseUrl ?? "https://api.fireblocks.io", "Fireblocks"),
  };
}
function invalid(): never {
  throw new SigningError("Invalid Fireblocks transfer response", "NETWORK_ERROR");
}
function result(value: unknown): FireblocksTransferResult {
  const parsed = transferResultSchema.safeParse(value);
  return parsed.success ? parsed.data : invalid();
}

/** Static catalogue only: share concurrent reads, cache successes for five minutes. */
export async function resolveFireblocksTransferAsset(
  runtime: CustodyProvisioningRuntime,
  access: FireblocksTransferAccess,
  nativeAsset: "SOL" | "SOL_TEST",
  mint: string | null
): Promise<{ id: string; decimals: number }> {
  if (mint === null) return { id: nativeAsset, decimals: 9 };
  const credentials = config(access);
  const cacheKey = `${credentials.apiBaseUrl}:${credentials.apiKey}`;
  let entry = catalogues.get(cacheKey);
  if (!entry || entry.expires <= runtime.now()) {
    if (catalogues.size >= 100) {
      // SAFETY: the size check guarantees a first entry; this synchronous read cannot interleave with another eviction.
      catalogues.delete(catalogues.keys().next().value as string);
    }
    const value = fireblocksRequest<unknown>(runtime, {
      ...credentials,
      method: "GET",
      uri: "/v1/supported_assets",
    }).then((assets) => {
      const parsed = z.array(assetSchema).max(100_000).safeParse(assets);
      return parsed.success ? parsed.data : invalid();
    });
    entry = { expires: runtime.now() + 300_000, value };
    catalogues.set(cacheKey, entry);
    const current = entry;
    value.catch(() => {
      if (catalogues.get(cacheKey) === current) catalogues.delete(cacheKey);
    });
  }
  const matches = (await entry.value).filter(
    (asset) =>
      asset?.type === "SOL_ASSET" &&
      asset.nativeAsset === nativeAsset &&
      asset.issuerAddress === mint
  );
  if (
    matches.length !== 1 ||
    typeof matches[0]?.id !== "string" ||
    typeof matches[0].decimals !== "number" ||
    !Number.isInteger(matches[0].decimals) ||
    matches[0].decimals < 0 ||
    matches[0].decimals > 18
  ) {
    throw new SigningError(
      "The token mint is not uniquely supported by Fireblocks on this Solana network",
      "INVALID_REQUEST"
    );
  }
  return { id: matches[0].id, decimals: matches[0].decimals };
}

/** A native transfer: Fireblocks builds, approves, signs and broadcasts. No RAW fallback. */
export async function createFireblocksTransfer(
  runtime: CustodyProvisioningRuntime,
  access: FireblocksTransferAccess,
  body: FireblocksTransferRequest
): Promise<FireblocksTransferResult> {
  return result(
    await fireblocksRequest(runtime, {
      ...config(access),
      method: "POST",
      uri: "/v1/transactions",
      body,
    })
  );
}

/** Recovery is read-only, including after timeouts and unknown submission outcomes. */
export async function readFireblocksTransfer(
  runtime: CustodyProvisioningRuntime,
  access: FireblocksTransferAccess,
  externalTxId: string
): Promise<FireblocksTransferResult | null> {
  try {
    return result(
      await fireblocksRequest(runtime, {
        ...config(access),
        method: "GET",
        uri: `/v1/transactions/external_tx_id/${encodeURIComponent(externalTxId)}`,
      })
    );
  } catch (error) {
    if (error instanceof FireblocksApiError && error.status === 404) return null;
    throw error;
  }
}
