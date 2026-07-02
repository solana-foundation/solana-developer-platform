"use server";

import { revalidatePath } from "next/cache";
import { sdpApiRequest } from "@/lib/sdp-api";
import { createIssuanceTokenAction } from "../actions";
import type { CreateAssetDraftInput, CreateAssetDraftResult } from "./draft-mapping";

function parseErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string };
    return parsed?.error?.message ?? parsed?.message ?? body ?? "Unknown error";
  } catch {
    return body || "Unknown error";
  }
}

/**
 * Create an issued-token draft and attach its Asset Profile — the two existing
 * endpoints orchestrated in one action. Guards the feature flag first so we
 * never create an orphan token when Asset Profiles are disabled. On a partial
 * failure (token created, profile POST failed) the created tokenId is returned
 * so a retry can re-attach the profile only via `existingTokenId`.
 */
export async function createAssetDraftAction(
  input: CreateAssetDraftInput
): Promise<CreateAssetDraftResult> {
  // 1. Feature-flag / reachability guard (no side effects yet).
  try {
    const metaResponse = await sdpApiRequest("/v1/asset-profiles/metadata", { method: "GET" });
    if (!metaResponse.ok) {
      const body = await metaResponse.text();
      const message =
        metaResponse.status === 403
          ? "Asset Profiles are not enabled for this environment."
          : `Asset profile check failed (${metaResponse.status}): ${parseErrorMessage(body)}`;
      return { state: "error", message, tokenId: input.existingTokenId ?? null };
    }
  } catch (error) {
    return {
      state: "error",
      message: error instanceof Error ? error.message : "Unable to reach the API.",
      tokenId: input.existingTokenId ?? null,
    };
  }

  // 2. Create the token draft (skip when retrying against an existing token).
  let tokenId = input.existingTokenId ?? null;
  if (!tokenId) {
    const form = new FormData();
    form.set("name", input.token.name);
    form.set("symbol", input.token.symbol);
    form.set("template", input.token.template);
    form.set("decimals", input.token.decimals);
    form.set("requiresAllowlist", String(input.token.requiresAllowlist));
    if (input.token.description) {
      form.set("description", input.token.description);
    }
    if (input.token.uri) {
      form.set("uri", input.token.uri);
    }
    if (input.token.imageUrl) {
      form.set("imageUrl", input.token.imageUrl);
    }
    if (input.token.signingWalletId) {
      form.set("signingWalletId", input.token.signingWalletId);
    }

    const tokenResult = await createIssuanceTokenAction(form);
    if (tokenResult.state !== "success" || !tokenResult.tokenId) {
      return {
        state: "error",
        message: tokenResult.message ?? "Failed to create the token draft.",
        tokenId: null,
      };
    }
    tokenId = tokenResult.tokenId;
  }

  // 3. Attach the asset profile.
  try {
    const response = await sdpApiRequest("/v1/asset-profiles", {
      method: "POST",
      body: JSON.stringify({
        tokenId,
        assetCategory: input.assetCategory,
        assetType: input.assetType,
        issuanceMetadata: input.issuanceMetadata,
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      // The token draft exists; return its id so the caller can retry the
      // profile step only.
      return {
        state: "error",
        message: `Couldn't attach the asset profile (${response.status}): ${parseErrorMessage(body)}`,
        tokenId,
      };
    }
  } catch (error) {
    return {
      state: "error",
      message: error instanceof Error ? error.message : "Unable to attach the asset profile.",
      tokenId,
    };
  }

  revalidatePath("/dashboard/issuance");
  return { state: "success", message: "Asset draft created.", tokenId };
}
