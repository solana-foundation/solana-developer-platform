"use server";

import { ORGANIZATION_RPC_PROVIDERS, type OrganizationRpcProvider } from "@sdp/types";
import { createOrgSdpApiClient } from "@/lib/sdp-api";

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

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Failed to save RPC settings.";
}

export async function updateOrganizationRpcSettingsAction(
  formData: FormData
): Promise<UpdateOrganizationRpcSettingsResult> {
  const organizationId = String(formData.get("organizationId") ?? "").trim();
  const rpcProvider = String(formData.get("rpcProvider") ?? "default").trim();

  if (!organizationId) {
    return {
      status: "error",
      message: "Missing organization id.",
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
        message: `RPC provider save mismatch (requested ${resolvedProvider}, persisted ${persistedProvider}).`,
      };
    }

    return {
      status: "success",
      message: "RPC settings saved.",
      savedOrganizationId: organizationId,
      savedRpcProvider: persistedProvider,
    };
  } catch (error) {
    return {
      status: "error",
      message: toErrorMessage(error),
    };
  }
}
