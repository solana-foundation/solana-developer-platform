"use server";

import { revalidatePath } from "next/cache";
import { parseErrorMessage } from "@/lib/api-error";
import { sdpApiRequest } from "@/lib/sdp-api";
import type { CreateAssetDraftInput, CreateAssetDraftResult } from "./draft-mapping";

/**
 * Create an issued-token draft together with its Asset Profile in a single call.
 *
 * `POST /v1/issuance/asset-profiles` writes the token row and the profile row in
 * one DB transaction, so there is no orphan-token failure mode to recover from:
 * either both are created or neither is.
 */
export async function createAssetDraftAction(
  input: CreateAssetDraftInput
): Promise<CreateAssetDraftResult> {
  const { token } = input;

  const payload: Record<string, unknown> = {
    name: token.name,
    symbol: token.symbol,
    template: token.template,
    requiresAllowlist: token.requiresAllowlist,
    assetCategory: input.assetCategory,
    assetType: input.assetType,
    issuanceMetadata: input.issuanceMetadata,
  };

  const decimals = Number.parseInt(token.decimals, 10);
  if (Number.isInteger(decimals)) {
    payload.decimals = decimals;
  }
  if (token.description) {
    payload.description = token.description;
  }
  if (token.uri) {
    payload.uri = token.uri;
  }
  if (token.imageUrl) {
    payload.imageUrl = token.imageUrl;
  }
  if (token.signingWalletId) {
    payload.signingWalletId = token.signingWalletId;
  }

  try {
    const response = await sdpApiRequest("/v1/issuance/asset-profiles", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text();
      const message =
        response.status === 403
          ? "Asset Profiles are not enabled for this environment."
          : `Couldn't create the asset draft (${response.status}): ${parseErrorMessage(body)}`;
      return { state: "error", message, tokenId: null };
    }

    const json = (await response.json()) as {
      data?: { token?: { id?: string } };
    };
    const tokenId = json?.data?.token?.id ?? null;

    revalidatePath("/dashboard/issuance");
    return { state: "success", message: "Asset draft created.", tokenId };
  } catch (error) {
    return {
      state: "error",
      message: error instanceof Error ? error.message : "Unable to create the asset draft.",
      tokenId: null,
    };
  }
}
