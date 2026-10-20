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

export interface FireblocksTransferResult {
  id: string;
  status: string;
  subStatus?: string;
  txHash?: string;
  externalTxId?: string;
  operation?: string;
  assetId?: string;
  source?: { type: string; id: string };
  destinationAddress?: string;
  amountInfo?: { amount?: string; requestedAmount?: string; netAmount?: string };
  feeCurrency?: string;
  feeInfo?: { networkFee?: string };
}

interface Asset {
  id: string;
  type: string;
  nativeAsset: string;
  issuerAddress?: string;
  decimals: number;
}
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
  if (!value || typeof value !== "object") return invalid();
  const item = value as FireblocksTransferResult;
  if (
    typeof item.id !== "string" ||
    !item.id ||
    item.id.length > 256 ||
    typeof item.status !== "string" ||
    !/^[A-Z_]{1,100}$/.test(item.status)
  )
    return invalid();
  for (const key of [
    "subStatus",
    "txHash",
    "externalTxId",
    "operation",
    "assetId",
    "destinationAddress",
  ] as const) {
    if (item[key] != null && (typeof item[key] !== "string" || item[key].length > 256))
      return invalid();
  }
  if (item.source != null) {
    if (typeof item.source !== "object" || Array.isArray(item.source)) return invalid();
    for (const key of ["type", "id"] as const) {
      if (typeof item.source[key] !== "string" || item.source[key].length > 256) return invalid();
    }
  }
  if (item.amountInfo != null) {
    if (typeof item.amountInfo !== "object" || Array.isArray(item.amountInfo)) return invalid();
    for (const key of ["amount", "requestedAmount", "netAmount"] as const) {
      const amount = item.amountInfo[key];
      if (
        amount != null &&
        (typeof amount !== "string" || amount.length > 100 || !/^\d+(\.\d+)?$/.test(amount))
      )
        return invalid();
    }
  }
  return item;
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
    if (catalogues.size >= 100) catalogues.delete(catalogues.keys().next().value as string);
    const value = fireblocksRequest<Asset[]>(runtime, {
      ...credentials,
      method: "GET",
      uri: "/v1/supported_assets",
    }).then((assets) => {
      if (!Array.isArray(assets)) return invalid();
      return assets;
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
      idempotencyKey: body.externalTxId,
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
