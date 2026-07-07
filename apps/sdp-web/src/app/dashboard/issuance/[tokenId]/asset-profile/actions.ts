"use server";

import type { AssetProfile } from "@sdp/types";
import { revalidatePath } from "next/cache";
import { sdpApiRequest } from "@/lib/sdp-api";
import {
  mergeIssuanceMetadataForUpdate,
  type UpdateAssetProfileActionInput,
  type UpdateAssetProfileActionResult,
} from "./asset-profile-mapping";

function parseErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string };
    return parsed?.error?.message ?? parsed?.message ?? body ?? "Unknown error";
  } catch {
    return body || "Unknown error";
  }
}

/**
 * Save the asset-management edit form: PATCH the token row (what deploy and the
 * dashboard read) and the asset profile (the canonical metadata record) so the
 * duplicated fields stay converged.
 *
 * The profile PATCH replaces the whole issuanceMetadata object, so the current
 * profile is re-fetched here and the form's rebuilt metadata is merged over it —
 * integration-written namespaces and unknown keys survive the save.
 */
export async function updateAssetProfileAction(
  input: UpdateAssetProfileActionInput
): Promise<UpdateAssetProfileActionResult> {
  const { tokenId, profileId, rebuiltMetadata, tokenPatch } = input;

  try {
    const profileResponse = await sdpApiRequest(`/v1/issuance/asset-profiles/${profileId}`, {
      method: "GET",
    });
    if (!profileResponse.ok) {
      const body = await profileResponse.text();
      return {
        state: "error",
        message: `Couldn't load the asset profile (${profileResponse.status}): ${parseErrorMessage(body)}`,
        assetProfile: null,
      };
    }
    const profileJson = (await profileResponse.json()) as {
      data?: { assetProfile?: AssetProfile };
    };
    const currentProfile = profileJson?.data?.assetProfile;
    if (!currentProfile) {
      return { state: "error", message: "Asset profile not found.", assetProfile: null };
    }

    const mergedMetadata = mergeIssuanceMetadataForUpdate(
      currentProfile.issuanceMetadata,
      rebuiltMetadata
    );

    // Token row first — it is what the rest of the dashboard displays. If the
    // profile PATCH then fails, retrying re-sends the same values (idempotent).
    const tokenResponse = await sdpApiRequest(`/v1/issuance/tokens/${tokenId}`, {
      method: "PATCH",
      body: JSON.stringify(tokenPatch),
    });
    if (!tokenResponse.ok) {
      const body = await tokenResponse.text();
      return {
        state: "error",
        message: `Couldn't save token details (${tokenResponse.status}): ${parseErrorMessage(body)}`,
        assetProfile: null,
      };
    }

    const updateResponse = await sdpApiRequest(`/v1/issuance/asset-profiles/${profileId}`, {
      method: "PATCH",
      body: JSON.stringify({ issuanceMetadata: mergedMetadata }),
    });
    if (!updateResponse.ok) {
      const body = await updateResponse.text();
      return {
        state: "error",
        message: `Token details were saved, but the asset profile update failed (${updateResponse.status}): ${parseErrorMessage(body)}. Please retry.`,
        assetProfile: null,
      };
    }

    const updateJson = (await updateResponse.json()) as {
      data?: { assetProfile?: AssetProfile };
    };

    revalidatePath(`/dashboard/issuance/${tokenId}`);
    revalidatePath("/dashboard/issuance");

    return {
      state: "success",
      message: "Changes saved.",
      assetProfile: updateJson?.data?.assetProfile ?? null,
    };
  } catch (error) {
    return {
      state: "error",
      message: error instanceof Error ? error.message : "Unable to save changes.",
      assetProfile: null,
    };
  }
}
