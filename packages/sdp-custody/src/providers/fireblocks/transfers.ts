import { z } from "zod";
import type { CustodyProvisioningRuntime } from "#/shared/runtime";
import { SigningError } from "#/signing";
import { FireblocksApiError, fireblocksRequest } from "./http";

export interface FireblocksTransferAccess {
  apiKey: string;
  apiSecretPem: string;
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

/** Earn's admitted transaction waist uses sign-only proposals; SDP owns broadcast. */
export interface FireblocksProgramCallRequest {
  operation: "PROGRAM_CALL";
  externalTxId: string;
  assetId: string;
  source: { type: "VAULT_ACCOUNT"; id: string };
  extraParameters: { programCallData: string; signOnly: true; useDurableNonce: false };
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
  status: z.string().regex(/^[A-Z0-9_]{1,100}$/),
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
  signedMessages: z
    .array(
      z.object({
        signature: z.object({ fullSig: z.string().regex(/^[a-fA-F0-9]{128}$/) }),
      })
    )
    .max(16)
    .nullish()
    .transform((value) => value ?? undefined)
    .optional(),
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
  const cacheKey = access.apiKey;
  let entry = catalogues.get(cacheKey);
  if (!entry || entry.expires <= runtime.now()) {
    if (catalogues.size >= 100) {
      // SAFETY: the size check guarantees a first entry; this synchronous read cannot interleave with another eviction.
      catalogues.delete(catalogues.keys().next().value as string);
    }
    const value = fireblocksRequest<unknown>(runtime, {
      ...access,
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
      ...access,
      method: "POST",
      uri: "/v1/transactions",
      body,
    })
  );
}

/** One POST behind the admitted Earn waist; external identity is persisted before this call. */
export async function createFireblocksProgramCall(
  runtime: CustodyProvisioningRuntime,
  access: FireblocksTransferAccess,
  body: FireblocksProgramCallRequest
): Promise<FireblocksTransferResult> {
  return result(
    await fireblocksRequest(runtime, {
      ...access,
      method: "POST",
      uri: "/v1/transactions",
      body,
      idempotencyKey: body.externalTxId,
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
        ...access,
        method: "GET",
        uri: `/v1/transactions/external_tx_id/${encodeURIComponent(externalTxId)}`,
      })
    );
  } catch (error) {
    if (error instanceof FireblocksApiError && error.status === 404) return null;
    throw error;
  }
}

/**
 * Request cancellation of a known transaction before broadcast. Acknowledgment is not a
 * terminal outcome: callers must keep reading the original external transaction id.
 */
export async function cancelFireblocksTransaction(
  runtime: CustodyProvisioningRuntime,
  access: FireblocksTransferAccess,
  transactionId: string
): Promise<boolean> {
  const response = await fireblocksRequest<unknown>(runtime, {
    ...access,
    method: "POST",
    uri: `/v1/transactions/${encodeURIComponent(transactionId)}/cancel`,
    // Cancellation cannot create another transfer. Do not cache a success:false reply for
    // 24 hours: every retry must ask the provider to evaluate cancellation again.
    // https://developers.fireblocks.com/api-reference/transactions/cancel-a-transaction
  });
  const parsed = z.object({ success: z.boolean() }).safeParse(response);
  if (!parsed.success) {
    throw new SigningError("Invalid Fireblocks cancellation response", "NETWORK_ERROR");
  }
  return parsed.data.success;
}

/** Request cancellation of a native transfer through the shared transaction endpoint. */
export function cancelFireblocksTransfer(
  runtime: CustodyProvisioningRuntime,
  access: FireblocksTransferAccess,
  transactionId: string
): Promise<boolean> {
  return cancelFireblocksTransaction(runtime, access, transactionId);
}
