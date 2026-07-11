"use server";

import { ORGANIZATION_RPC_PROVIDERS, type OrganizationRpcProvider } from "@sdp/types";
import { createOrgSdpApiClient } from "@/lib/sdp-api";
import { getTranslations } from "@/i18n/server";

type OrganizationSettings = {
  rpcProvider?: OrganizationRpcProvider;
};

type OrganizationRecord = {
  id: string;
  settings: OrganizationSettings | null;
};

type UpdateOrganizationRpcSettingsResult = {
  status: "success" | "error";
  message: string;
  savedOrganizationId?: string;
  savedRpcProvider?: OrganizationRpcProvider;
};

function isOrganizationRpcProvider(value: string): value is OrganizationRpcProvider {
  return ORGANIZATION_RPC_PROVIDERS.includes(value as OrganizationRpcProvider);
}

function toErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

export async function updateOrganizationRpcSettingsAction(
  formData: FormData
): Promise<UpdateOrganizationRpcSettingsResult> {
  const t = await getTranslations();
  const organizationId = String(formData.get("organizationId") ?? "").trim();
  const rpcProvider = String(formData.get("rpcProvider") ?? "default").trim();

  if (!organizationId) {
    return {
      status: "error",
      message: t("DashboardCustody.missingOrganizationId"),
    };
  }

  const resolvedProvider: OrganizationRpcProvider = isOrganizationRpcProvider(rpcProvider)
    ? rpcProvider
    : "default";

  try {
    const client = await createOrgSdpApiClient();
    const updated = await client.fetch<OrganizationRecord>(`/v1/organizations/${organizationId}`, {
      method: "PATCH",
      body: JSON.stringify({
        settings: { rpcProvider: resolvedProvider },
      }),
    });

    const persistedProvider = updated.settings?.rpcProvider ?? "default";
    if (persistedProvider !== resolvedProvider) {
      return {
        status: "error",
        message: t("DashboardCustody.rpcProviderSaveMismatch", {
          requested: resolvedProvider,
          persisted: persistedProvider,
        }),
      };
    }

    return {
      status: "success",
      message: t("DashboardCustody.rpcSettingsSaved"),
      savedOrganizationId: organizationId,
      savedRpcProvider: persistedProvider,
    };
  } catch (error) {
    return {
      status: "error",
      message: toErrorMessage(error, t("DashboardCustody.failedToSaveRpcSettings")),
    };
  }
}
