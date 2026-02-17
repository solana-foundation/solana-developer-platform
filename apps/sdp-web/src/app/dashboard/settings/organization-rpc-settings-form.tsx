"use client";

import { Label } from "@/components/ui/label";
import { useEffect, useState } from "react";
import { updateOrganizationRpcSettingsAction } from "./actions";

type OrganizationSettings = {
  rpcProvider?: "default" | "triton" | "helius" | "alchemy";
};

export type SettingsOrganization = {
  id: string;
  name: string;
  settings: OrganizationSettings | null;
};

export function OrganizationRpcSettingsForm({
  organization,
}: {
  organization: SettingsOrganization;
}) {
  const rpcProvider = organization.settings?.rpcProvider ?? "default";
  const [selectedProvider, setSelectedProvider] = useState<
    "default" | "triton" | "helius" | "alchemy"
  >(rpcProvider);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    setSelectedProvider(organization.settings?.rpcProvider ?? "default");
    setErrorMessage(null);
  }, [organization.settings?.rpcProvider]);

  const saveProvider = async (provider: "default" | "triton" | "helius" | "alchemy") => {
    const formData = new FormData();
    formData.set("organizationId", organization.id);
    formData.set("rpcProvider", provider);

    const result = await updateOrganizationRpcSettingsAction(formData);
    if (result.status !== "success") {
      setErrorMessage(result.message || "Failed to save RPC settings.");
      return;
    }

    setErrorMessage(null);
    setSelectedProvider(result.savedRpcProvider ?? provider);
  };

  return (
    <div className="grid gap-5">
      <div className="w-full max-w-3xl space-y-5">
        <div className="rounded-xl border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.03)] px-3 py-2">
          <div className="flex items-center gap-3">
            <span className="text-sm text-[rgba(28,28,29,0.7)]">
              Editing organization: {organization.name}
            </span>
          </div>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="rpcProvider">RPC provider</Label>
          <select
            id="rpcProvider"
            name="rpcProvider"
            className="h-10 w-full rounded-lg border border-[rgba(28,28,29,0.16)] bg-white px-3 text-sm text-[#1c1c1d]"
            value={selectedProvider}
            onChange={(event) => {
              const nextProvider = event.currentTarget.value as typeof selectedProvider;
              setSelectedProvider(nextProvider);
              void saveProvider(nextProvider);
            }}
          >
            <option value="default">SDP</option>
            <option value="triton">Triton</option>
            <option value="helius">Helius</option>
            <option value="alchemy">Alchemy</option>
          </select>
        </div>
      </div>

      {errorMessage ? (
        <div className="w-full max-w-3xl rounded-xl border border-[rgba(158,43,56,0.2)] bg-[rgba(158,43,56,0.06)] px-3 py-2 text-sm text-[#9e2b38]">
          {errorMessage}
        </div>
      ) : null}
    </div>
  );
}
