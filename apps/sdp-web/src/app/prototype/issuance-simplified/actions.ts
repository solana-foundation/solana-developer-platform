"use server";

import { revalidatePath } from "next/cache";
import { parseErrorMessage } from "@/lib/api-error";
import { sdpApiRequest } from "@/lib/sdp-api";

export async function saveIssuancePrototypeDraft(input: {
  assetClass: "stablecoin" | "digital-asset";
  name: string;
  symbol: string;
  description: string;
  website: string;
  maxSupply: string;
  decimals: string;
  allowlist: boolean;
  pauseTransfers: boolean;
  interestBearing: boolean;
  interestRate: string;
  transferFee: boolean;
  transferFeeBasisPoints: string;
  transferFeeMax: string;
  authorities: Record<"mint" | "burn" | "freeze" | "pause", string>;
}): Promise<{ state: "success" | "error"; message: string; tokenId: string | null }> {
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
          authorityAssignments: input.authorities,
        },
      },
      ...(Object.keys(selectedSettings).length > 0
        ? { settings: { selected: selectedSettings } }
        : {}),
    },
  };

  if (input.maxSupply.trim()) payload.maxSupply = input.maxSupply.trim();

  try {
    const response = await sdpApiRequest("/v1/issuance/asset-profiles", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      return {
        state: "error",
        message: parseErrorMessage(await response.text()),
        tokenId: null,
      };
    }

    const body = (await response.json()) as { data?: { token?: { id?: string } } };
    revalidatePath("/dashboard/issuance");
    return {
      state: "success",
      message: "Draft saved to SDP.",
      tokenId: body.data?.token?.id ?? null,
    };
  } catch (error) {
    return {
      state: "error",
      message: error instanceof Error ? error.message : "Unable to save draft.",
      tokenId: null,
    };
  }
}
