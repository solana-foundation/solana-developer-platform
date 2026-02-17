"use server";

import { sdpApiFetch } from "@/lib/sdp-api";

type OrganizationSettings = {
  rpcProvider?: "default" | "triton" | "helius" | "alchemy";
};

type OrganizationRecord = {
  id: string;
  settings: OrganizationSettings | null;
};

type UpdateOrganizationRpcSettingsResult = {
  status: "success" | "error";
  message: string;
  savedOrganizationId?: string;
  savedRpcProvider?: "default" | "triton" | "helius" | "alchemy";
};

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

  const allowedProviders = new Set(["default", "triton", "helius", "alchemy"]);
  const resolvedProvider = allowedProviders.has(rpcProvider) ? rpcProvider : "default";

  try {
    const updated = await sdpApiFetch<OrganizationRecord>(`/v1/organizations/${organizationId}`, {
      method: "PATCH",
      body: JSON.stringify({
        settings: { rpcProvider: resolvedProvider as OrganizationSettings["rpcProvider"] },
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
      savedRpcProvider: persistedProvider as "default" | "triton" | "helius" | "alchemy",
    };
  } catch (error) {
    return {
      status: "error",
      message: toErrorMessage(error),
    };
  }
}
