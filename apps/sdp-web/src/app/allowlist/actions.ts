"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "@/i18n/server";
import { createOrgSdpApiClient } from "@/lib/sdp-api";

export interface AllowlistEntry {
  id: string;
  type: "email" | "domain";
  value: string;
  tier: string;
  status: "active" | "disabled";
  createdAt: string;
}

export async function listAllowlistEntries(): Promise<AllowlistEntry[]> {
  const client = await createOrgSdpApiClient();
  const response = await client.fetch<{ entries: AllowlistEntry[] }>("/admin/allowlist");
  return response.entries;
}

export async function addAllowlistEntry(formData: FormData) {
  const t = await getTranslations();
  const value = String(formData.get("value") ?? "").trim();
  const type = (String(formData.get("type") ?? "email").trim() || "email") as "email" | "domain";

  if (!value) {
    throw new Error(t("Shared.validation.allowlistValueRequired"));
  }

  const client = await createOrgSdpApiClient();
  await client.fetch("/admin/allowlist", {
    method: "POST",
    body: JSON.stringify({ type, value }),
  });

  revalidatePath("/allowlist");
}

export async function removeAllowlistEntry(formData: FormData) {
  const t = await getTranslations();
  const id = String(formData.get("id") ?? "").trim();
  if (!id) {
    throw new Error(t("Shared.validation.allowlistEntryIdRequired"));
  }

  const client = await createOrgSdpApiClient();
  await client.fetch(`/admin/allowlist/${id}`, {
    method: "DELETE",
  });

  revalidatePath("/allowlist");
}
