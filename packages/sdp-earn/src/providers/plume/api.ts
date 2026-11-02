import { PLUME_API_BASE_URL } from "@sdp/types/plume-programs";
import { z } from "zod";
import { internalError, SdpEarnError } from "#/errors";
import { providerFetch } from "#/fetch";

const decimal = z.number().finite().nonnegative();
export const plumeVaultInfoSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  decimals: z.number().int().min(0).max(18),
  solana: z.object({
    mintAddress: z.string().min(1),
    oftStoreAddress: z.string().min(1),
    decimals: z.number().int().min(0).max(18),
  }),
  // Legacy V1 composers (redeem path) predate Plume's chain metadata: the live
  // nOPAL listing omits `chainId`/`cctpDepositEnabled` on them. Only a selected
  // V2 composer's fields are load-bearing, and the client validates those
  // strictly at selection time.
  nestComposers: z.array(
    z.object({
      composerAddress: z.string().min(1),
      chainId: z.number().int().optional(),
      complianceVersion: z.enum(["v1", "v2"]),
      cctpDepositEnabled: z.boolean().optional(),
    })
  ),
  // Reported metadata is nullable upstream; a null figure is absence, not a
  // malformed body.
  targetApy: decimal.nullish(),
  tvl: decimal.nullish(),
});
export const plumePriceSchema = z.object({ price: z.number().finite().positive() });
export const plumeTransactionSchema = z.object({ txBase64: z.string().min(1) });
const delivery = z.object({ signature: z.string().nullish() }).nullish();
const flowError = z
  .object({ code: z.string().optional(), message: z.string().optional() })
  .nullish();
export const plumeMintStatusSchema = z
  .object({
    solanaSignature: z.string(),
    solanaWallet: z.string(),
    steps: z.object({ solanaMint: delivery }),
    error: flowError,
  })
  .transform((v) => ({
    sourceSignature: v.solanaSignature,
    owner: v.solanaWallet,
    destinationSignature: v.steps.solanaMint?.signature ?? null,
    recoveryRequired: !!v.error?.code,
  }));
export const plumeRedeemStatusSchema = z
  .object({
    solanaBurnSignature: z.string(),
    solanaWallet: z.string(),
    steps: z.object({ solanaClaim: delivery }),
    error: flowError,
  })
  .transform((v) => ({
    sourceSignature: v.solanaBurnSignature,
    owner: v.solanaWallet,
    destinationSignature: v.steps.solanaClaim?.signature ?? null,
    recoveryRequired: !!v.error?.code,
  }));
export const plumeCancellationStatusSchema = z
  .object({
    solanaBurnSignature: z.string(),
    solanaWallet: z.string(),
    eventType: z.literal("UpdateRedeemRequest"),
    redeemType: z.literal("async"),
    steps: z.object({
      plumeProcessing: z.object({
        sharesUpdatedTotal: z.string(),
        vaultComposerAddress: z.string(),
      }),
      solanaReturnShares: delivery,
    }),
  })
  .transform((v) => ({
    sourceSignature: v.solanaBurnSignature,
    owner: v.solanaWallet,
    destinationSignature: v.steps.solanaReturnShares?.signature ?? null,
    remainingShares: v.steps.plumeProcessing.sharesUpdatedTotal,
    composer: v.steps.plumeProcessing.vaultComposerAddress,
  }));

/** Every upstream body is parsed here. A malformed 200 must never shrink the shelf. */
export async function plumeRequest<T>(
  path: string,
  schema: z.ZodType<T>,
  body?: Record<string, string | number>
): Promise<T> {
  const result = await providerFetch("plume", `${PLUME_API_BASE_URL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    body,
    timeoutMs: 15_000,
  });
  if (!result.response.ok) {
    // No upstream prose: it may contain attestations, addresses or transport details.
    const status = result.response.status;
    throw new SdpEarnError(
      status === 429 ? "RATE_LIMITED" : status >= 500 ? "PROVIDER_UNAVAILABLE" : "BAD_REQUEST",
      "Plume could not complete this request",
      { provider: "plume", providerStatus: status }
    );
  }
  const parsed = z.object({ data: schema }).safeParse(result.parsed);
  if (!parsed.success) throw internalError("Plume returned an invalid response");
  return parsed.data.data;
}
