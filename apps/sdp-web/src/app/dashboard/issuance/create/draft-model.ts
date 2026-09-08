import { z } from "zod";

export const draftSchema = z
  .object({
    assetClass: z.enum(["stablecoin", "digital-asset"]),
    name: z.string().trim().min(1, "Enter a token name.").max(100),
    symbol: z.string().trim().min(1, "Enter a symbol.").max(10),
    description: z.string().max(2000),
    website: z.union([z.literal(""), z.url({ protocol: /^https?$/ })]),
    maxSupply: z.string().regex(/^$|^[1-9]\d*$/, "Enter a positive whole-number supply cap."),
    decimals: z.string().regex(/^[0-9]$/, "Decimals must be between 0 and 9."),
    allowlist: z.boolean(),
    pauseTransfers: z.boolean(),
    interestBearing: z.boolean(),
    interestRate: z.string(),
    transferFee: z.boolean(),
    transferFeeBasisPoints: z.string(),
    transferFeeMax: z.string(),
    authorities: z.object({
      "mint-authority": z.string().min(1),
      "metadata-authority": z.string().min(1),
      "freeze-authority": z.string(),
      "permanent-delegate": z.string(),
    }),
  })
  .refine((input) => input.assetClass !== "stablecoin" || input.decimals === "6", {
    message: "Stablecoins use 6 decimal places.",
  });

export type DraftState = z.infer<typeof draftSchema>;
export type AuthorityKey = keyof DraftState["authorities"];

export function buildDraftPayload(input: DraftState): Record<string, unknown> {
  const isStablecoin = input.assetClass === "stablecoin";
  const selectedSettings: Record<string, { params?: Record<string, string> }> = {};

  if (!isStablecoin && input.pauseTransfers) selectedSettings.pauseTransfers = {};
  if (!isStablecoin && input.interestBearing) {
    selectedSettings.interestBearing = { params: { rate: input.interestRate } };
  }
  if (!isStablecoin && input.transferFee) {
    selectedSettings.transferFee = {
      params: {
        basisPoints: input.transferFeeBasisPoints,
        maxFee: input.transferFeeMax,
      },
    };
  }

  const payload: Record<string, unknown> = {
    name: input.name.trim(),
    symbol: input.symbol.trim(),
    description: input.description.trim() || undefined,
    decimals: Number.parseInt(input.decimals, 10),
    template: isStablecoin ? "stablecoin" : "custom",
    requiresAllowlist: input.allowlist,
    isMintable: true,
    isFreezable: isStablecoin,
    assetCategory: isStablecoin ? "stablecoin" : "generic",
    assetType: "generic",
    issuanceMetadata: {
      asset: {
        name: input.name.trim(),
        description: input.description.trim() || undefined,
        website: input.website.trim() || undefined,
      },
      chain: { decimals: Number.parseInt(input.decimals, 10) },
      custom: {
        customer: {
          authorityWalletIds: Object.fromEntries(
            Object.entries(input.authorities).filter(
              ([key]) => isStablecoin || key === "mint-authority" || key === "metadata-authority"
            )
          ),
        },
      },
      ...(Object.keys(selectedSettings).length > 0
        ? { settings: { selected: selectedSettings } }
        : {}),
    },
  };

  if (input.maxSupply.trim()) payload.maxSupply = input.maxSupply.trim();
  payload.signingWalletId = input.authorities["mint-authority"];

  return payload;
}
