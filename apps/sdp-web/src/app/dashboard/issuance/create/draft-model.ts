import { z } from "zod";
import { getTokenAccessControlMode } from "../access-control.utils";

export const draftSchema = z
  .object({
    assetClass: z.enum(["stablecoin", "digital-asset"]),
    name: z.string().trim().min(1, "Enter a token name.").max(100),
    symbol: z
      .string()
      .trim()
      .min(1)
      .max(10)
      .regex(/^[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*$/),
    description: z.string().max(500),
    website: z.union([z.literal(""), z.url({ protocol: /^https?$/ }).max(2048)]),
    maxSupply: z.string().regex(/^$|^[1-9]\d*$/, "Enter a positive whole-number supply cap."),
    decimals: z.string().regex(/^(?:[0-9]|1[0-8])$/),
    allowlist: z.boolean(),
    pauseTransfers: z.boolean(),
    interestBearing: z.boolean(),
    interestRate: z.string(),
    transferFee: z.boolean(),
    transferFeeBasisPoints: z.string(),
    transferFeeMax: z.string(),
    // The new design's draft flow also asks for the issuer, the currency and, for a token that
    // is not a stablecoin, whether it can freeze accounts and has a permanent delegate (a
    // stablecoin always has both). The previous design's form sends none of them.
    issuerName: z.string().trim().max(200).optional(),
    pegCurrency: z.enum(["USD", "EUR", "GBP"]).optional(),
    freezeAccounts: z.boolean().optional(),
    permanentDelegate: z.boolean().optional(),
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
  if (!isStablecoin && input.freezeAccounts) selectedSettings.freezeAccounts = {};
  if (!isStablecoin && input.permanentDelegate) selectedSettings.permanentDelegate = {};
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
    isFreezable: isStablecoin || input.freezeAccounts === true,
    assetCategory: isStablecoin ? "stablecoin" : "generic",
    assetType: "generic",
    issuanceMetadata: {
      compliance: {
        accessControl: getTokenAccessControlMode({
          template: isStablecoin ? "stablecoin" : "custom",
          requiresAllowlist: input.allowlist,
        }),
      },
      asset: {
        name: input.name.trim(),
        description: input.description.trim() || undefined,
        website: input.website.trim() || undefined,
        issuerName: input.issuerName?.trim() || undefined,
        pegCurrency: input.pegCurrency,
      },
      chain: { decimals: Number.parseInt(input.decimals, 10) },
      custom: {
        customer: {
          authorityWalletIds: Object.fromEntries(
            Object.entries(input.authorities).filter(([key]) =>
              isDraftAuthorityInUse(input, key as AuthorityKey)
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
  payload.signingCustodyWalletId = input.authorities["mint-authority"];

  return payload;
}

/**
 * Whether the draft's token has the authority at all: a stablecoin has all four; any other
 * token has mint and metadata, and freeze or the permanent delegate only when it asks for them.
 */
export function isDraftAuthorityInUse(input: DraftState, key: AuthorityKey): boolean {
  if (input.assetClass === "stablecoin") return true;
  if (key === "mint-authority" || key === "metadata-authority") return true;
  if (key === "freeze-authority") return input.freezeAccounts === true;
  return input.permanentDelegate === true;
}
