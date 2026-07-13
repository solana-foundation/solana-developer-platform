"use server";

import type { AssetProfile } from "@sdp/types";
import { revalidatePath } from "next/cache";
import { getTranslations } from "@/i18n/server";
import { parseErrorMessage } from "@/lib/api-error";
import { sdpApiRequest } from "@/lib/sdp-api";
import {
  mergeIssuanceMetadataForUpdate,
  type UpdateAssetProfileActionInput,
  type UpdateAssetProfileActionResult,
} from "./asset-profile-mapping";

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
  const t = await getTranslations();
  const { tokenId, profileId, rebuiltMetadata, tokenPatch } = input;

  try {
    const profileResponse = await sdpApiRequest(`/v1/issuance/asset-profiles/${profileId}`, {
      method: "GET",
    });
    if (!profileResponse.ok) {
      const body = await profileResponse.text();
      return {
        state: "error",
        message: t("DashboardIssuance.errors.assetProfileLoadFailed", {
          status: profileResponse.status,
          error: parseErrorMessage(body),
        }),
        assetProfile: null,
      };
    }
    const profileJson = (await profileResponse.json()) as {
      data?: { assetProfile?: AssetProfile };
    };
    const currentProfile = profileJson?.data?.assetProfile;
    if (!currentProfile) {
      return {
        state: "error",
        message: t("DashboardIssuance.errors.assetProfileNotFound"),
        assetProfile: null,
      };
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
        message: t("DashboardIssuance.errors.tokenDetailsSaveFailed", {
          status: tokenResponse.status,
          error: parseErrorMessage(body),
        }),
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
        message: t("DashboardIssuance.errors.assetProfileUpdateFailed", {
          status: updateResponse.status,
          error: parseErrorMessage(body),
        }),
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
      message: t("DashboardIssuance.errors.changesSaved"),
      assetProfile: updateJson?.data?.assetProfile ?? null,
    };
  } catch (error) {
    return {
      state: "error",
      message:
        error instanceof Error ? error.message : t("DashboardIssuance.errors.unableToSaveChanges"),
      assetProfile: null,
    };
  }
}
